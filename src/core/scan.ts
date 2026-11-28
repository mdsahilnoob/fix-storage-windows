import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promises as fsp } from "node:fs";
import { basename, join } from "node:path";
import { CATEGORIES, type CategoryId, type Root } from "./categories";
import type { Drive } from "./drives";
import type { Layout } from "./layout";
import { IS_MAC, IS_WINDOWS } from "./platform";
import { extendedPath, normalPath, windowsEntryKind } from "./windows/paths";
import { windowsDu } from "./windows/scan";

export type ItemKind = "file" | "directory" | "symlink" | "junction" | "reparse" | "unknown";

export interface Item {
  path: string;
  size: number;
  /** True for folders, which can be opened for a closer look. */
  dir?: boolean;
  /** Explicit type when the scanner can distinguish it. */
  kind?: ItemKind;
}

export type ScanPhase = "scanning" | "completed" | "cancelled" | "failed";

export interface ScanSnapshot extends Space {
  phase: ScanPhase;
  /** Sum of the file and folder estimates, before accounting for unmeasured space. */
  measured: number;
  sizes: Record<CategoryId, number>;
  /** Measured folders per category, largest first. */
  items: Record<CategoryId, Item[]>;
  /** Path being measured right now. */
  current: string;
  /** Folders this process may not read. */
  blocked: string[];
  /** Failure detail when phase is "failed". */
  error?: string;
}

export interface ScanHandle {
  cancel(): void;
  done: Promise<ScanSnapshot>;
}

export function unmeasuredBytes({ used, measured }: ScanSnapshot): number {
  return Math.max(0, used - measured);
}

export function emptyRecord<T>(make: () => T): Record<CategoryId, T> {
  return Object.fromEntries(CATEGORIES.map((c) => [c.id, make()])) as Record<CategoryId, T>;
}

export function emptySnapshot(): ScanSnapshot {
  return {
    phase: "scanning",
    total: 0,
    available: 0,
    used: 0,
    measured: 0,
    sizes: emptyRecord(() => 0),
    items: emptyRecord<Item[]>(() => []),
    current: "",
    blocked: [],
  };
}

export interface Space {
  /** Filesystem capacity in bytes. */
  total: number;
  /** Free bytes this account can use. */
  available: number;
  /** Bytes in use. On Linux this leaves out the blocks reserved for root, the way df counts. */
  used: number;
}

export async function diskSpace(drive?: Drive): Promise<Space> {
  const paths = IS_WINDOWS
    ? [drive?.mount ?? `${process.env.SystemDrive ?? "C:"}\\`]
    : IS_MAC || !drive
      ? ["/System/Volumes/Data", "/"]
      : [drive.mount];
  for (const path of paths) {
    try {
      const s = await fsp.statfs(path);
      const total = s.blocks * s.bsize;
      const available = s.bavail * s.bsize;
      return { total, available, used: IS_MAC || IS_WINDOWS ? total - available : (s.blocks - s.bfree) * s.bsize };
    } catch {
      // try the next one
    }
  }
  if (IS_WINDOWS && drive?.capacity) {
    const available = drive.freeSpace ?? 0;
    return { total: drive.capacity, available, used: Math.max(0, drive.capacity - available) };
  }
  return { total: 0, available: 0, used: 0 };
}

function denied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "EACCES";
}

const STALL_CHECK_MS = 5000;

interface DuResult {
  bytes: number;
  denied: boolean;
}

/** Disk usage of one folder via du on Unix, which is far faster than walking it in JS. */
function duUnix(path: string, children: Set<ChildProcess>, isCancelled: () => boolean): Promise<DuResult> {
  return new Promise((resolve) => {
    const child = spawn("du", ["-skx", path], { stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    // Cancellation can race with spawning. Stop this child as soon as it exists.
    if (isCancelled()) child.kill();
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => {
      if (err.length < 4096) err += chunk;
    });
    // A folder guarded by a macOS privacy prompt (Music, TV, Photos) makes du
    // wait for an answer that may never come. A du that has used no CPU time
    // between two checks is waiting like that: give up on it and report the
    // folder as unreadable. Linux has no such prompts, and its ps counts CPU
    // time in whole seconds, so a du busy reading a slow disk would look stuck.
    let stalled = false;
    let lastCpu = "";
    const check = () => {
      if (child.pid === undefined) return;
      execFile("ps", ["-o", "cputime=", "-p", String(child.pid)], (error, stdout) => {
        const cpu = stdout.trim();
        if (error || cpu === "") return;
        if (cpu === lastCpu) {
          stalled = true;
          child.kill();
        }
        lastCpu = cpu;
      });
    };
    const watchdog = IS_MAC ? setInterval(check, STALL_CHECK_MS) : undefined;

    const finish = () => {
      clearInterval(watchdog);
      children.delete(child);
      const kb = Number.parseInt(out, 10);
      resolve({
        bytes: Number.isFinite(kb) ? kb * 1024 : 0,
        denied: stalled || /not permitted|Permission denied/.test(err),
      });
    };
    child.on("error", finish);
    child.on("close", finish);
  });
}

/** One measurement policy shared by scans, browsing and post-clean reports. */
export function du(path: string, children: Set<ChildProcess>, isCancelled: () => boolean = () => false): Promise<DuResult> {
  return IS_WINDOWS ? windowsDu(path, isCancelled) : duUnix(path, children, isCancelled);
}

interface Unit {
  path: string;
  category: CategoryId;
}

export interface ScanOptions {
  /** How many folders to measure at once. */
  concurrency?: number;
  /** Minimum milliseconds between onUpdate calls. */
  throttleMs?: number;
}

export function startScan(layout: Layout, onUpdate: (snapshot: ScanSnapshot) => void, options: ScanOptions = {}): ScanHandle {
  const concurrency = options.concurrency ?? 6;
  const throttleMs = options.throttleMs ?? 40;

  const snap = emptySnapshot();
  const children = new Set<ChildProcess>();
  let cancelled = false;
  let finished = false;
  let lastEmit = 0;

  const emit = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < throttleMs) return;
    lastEmit = now;
    onUpdate({ ...snap, sizes: { ...snap.sizes } });
  };

  const add = (category: CategoryId, bytes: number) => {
    snap.sizes[category] += bytes;
    snap.measured += bytes;
  };

  const finish = async (phase: "completed" | "cancelled" | "failed", error?: string): Promise<ScanSnapshot> => {
    if (finished) return snap;
    finished = true;
    for (const list of Object.values(snap.items)) list.sort((a, b) => b.size - a.size);
    if (phase === "completed") {
      // Only a complete scan accounts for unmeasured space as System data.
      const after = await diskSpace(layout.drive);
      if (after.total > 0) Object.assign(snap, after);
      snap.sizes.system += unmeasuredBytes(snap);
    }
    snap.current = "";
    snap.phase = phase;
    if (error) snap.error = error;
    emit(true);
    return snap;
  };

  const run = async (): Promise<ScanSnapshot> => {
    try {
      Object.assign(snap, await diskSpace(layout.drive));
      if (cancelled) return finish("cancelled");
      emit(true);

      const all = layout.roots;
      const pathKey = (path: string) => (IS_WINDOWS ? normalPath(path) : path);
      const rootPaths = new Set(all.map((r) => pathKey(r.path)));
      const holdsRoot = (path: string) => {
        const key = pathKey(path);
        const prefix = key + (IS_WINDOWS ? "\\" : "/");
        return all.some((r) => pathKey(r.path).startsWith(prefix));
      };

      const units: Unit[] = [];

      // Lists a folder, queueing each subfolder for du and adding loose files
      // straight away. Subfolders that hold another root are opened instead of
      // measured whole, so the inner root is not counted twice.
      const addFile = async (path: string, category: CategoryId) => {
        if (cancelled) return;
        try {
          const stat = await fsp.lstat(IS_WINDOWS ? extendedPath(path) : path);
          if (cancelled) return;
          const bytes = IS_WINDOWS ? Number(stat.size) : stat.blocks * 512;
          add(category, bytes);
          const kind: ItemKind = stat.isSymbolicLink()
            ? IS_WINDOWS ? "reparse" : "symlink"
            : stat.isDirectory() ? "directory" : "file";
          if (bytes > 0) snap.items[category].push({ path, size: bytes, dir: false, kind });
        } catch (error) {
          // A vanished file contributes nothing. Permission failures are real
          // scan errors and must not disappear into the aggregate.
          if (denied(error)) report(path, category);
        }
      };

      // Unreadable system folders are expected; they count as System data after
      // a complete scan. Cancelled and failed scans keep them separate.
      const report = (path: string, category: CategoryId) => {
        if (category !== "system" && basename(path) !== "lost+found") snap.blocked.push(path);
      };

      const expand = async (path: string, category: CategoryId, hidden?: CategoryId): Promise<void> => {
        if (cancelled) return;
        if (IS_WINDOWS) {
          const kind = await windowsEntryKind(path);
          if (cancelled) return;
          if (kind === "link") {
            report(path, category);
            return;
          }
          if (kind === "file") {
            await addFile(path, category);
            return;
          }
          if (kind === "missing") {
            report(path, category);
            return;
          }
        }
        let entries;
        try {
          entries = await fsp.readdir(IS_WINDOWS ? extendedPath(path) : path, { withFileTypes: true });
        } catch (error) {
          // A root can be a single file, like a swap file.
          if ((error as NodeJS.ErrnoException).code === "ENOTDIR") await addFile(path, category);
          else if (denied(error)) report(path, category);
          return;
        }
        for (const entry of entries) {
          if (cancelled) return;
          const child = join(path, entry.name);
          if (rootPaths.has(pathKey(child)) || layout.skip(child) || layout.foreign(child)) continue;
          const kind = hidden !== undefined && entry.name.startsWith(".") ? hidden : category;
          if (entry.isDirectory()) {
            if (holdsRoot(child)) {
              await expand(child, kind);
              if (cancelled) return;
            } else {
              units.push({ path: child, category: kind });
            }
          } else {
            await addFile(child, kind);
            if (cancelled) return;
          }
        }
      };

      const order = CATEGORIES.map((c) => c.id);
      const sorted: Root[] = [...all].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
      for (const root of sorted) {
        if (cancelled) return finish("cancelled");
        if (layout.foreign(root.path)) continue;
        snap.current = root.path;
        await expand(root.path, root.category, root.hidden);
        if (cancelled) return finish("cancelled");
        emit();
      }

      let next = 0;
      const worker = async () => {
        while (!cancelled && next < units.length) {
          const unit = units[next++];
          snap.current = unit.path;
          emit();
          const result = await du(unit.path, children, () => cancelled);
          if (cancelled) return;
          add(unit.category, result.bytes);
          if (result.bytes > 0) snap.items[unit.category].push({ path: unit.path, size: result.bytes, dir: true, kind: "directory" });
          if (result.denied) report(unit.path, unit.category);
          emit();
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
      if (cancelled) return finish("cancelled");

      return finish("completed");
    } catch (error) {
      return finish("failed", error instanceof Error ? error.message : String(error));
    }
  };

  return {
    cancel() {
      if (finished) return;
      cancelled = true;
      for (const child of children) child.kill();
    },
    done: run(),
  };
}

/** Re-measures one category after something was deleted from it. */
export async function measure(category: CategoryId, layout: Layout): Promise<number> {
  const children = new Set<ChildProcess>();
  let total = 0;
  for (const root of layout.roots) {
    if (root.category !== category) continue;
    total += (await du(root.path, children)).bytes;
  }
  return total;
}

import { randomUUID } from "node:crypto";
import { CATEGORIES, type CategoryId } from "./categories";
import { diskSpace, type Item, type ItemKind, type ScanHandle, type ScanPhase, type ScanSnapshot } from "./scan";
import type { Layout } from "./layout";
import { normalPath } from "./windows/paths";
import {
  launchRustScanner,
  type RustEntry,
  type RustIssue,
  type RustScanRequest,
  type RustScannerHandle,
} from "./rust-scanner";

export interface RustScanOptions {
  executable: string;
  batchSize?: number;
  threads?: number;
  timeoutMs?: number;
}

function emptyItems(): Record<CategoryId, Item[]> {
  const result = {} as Record<CategoryId, Item[]>;
  for (const category of CATEGORIES) result[category.id] = [];
  return result;
}

function emptySizes(): Record<CategoryId, number> {
  const result = {} as Record<CategoryId, number>;
  for (const category of CATEGORIES) result[category.id] = 0;
  return result;
}

function itemKind(type: string): ItemKind {
  return ["file", "directory", "symlink", "junction", "reparse", "unknown"].includes(type)
    ? (type as ItemKind)
    : "unknown";
}

function snapshotFrom(
  entries: RustEntry[],
  errors: RustIssue[],
  volume: { totalBytes: number; usedBytes: number; availableBytes: number },
  phase: ScanPhase,
  current = "",
  error?: string,
  totals?: { measuredBytes: number; categoryBytes: Record<string, number> },
): ScanSnapshot {
  const items = emptyItems();
  const sizes = emptySizes();
  for (const entry of entries) {
    if (!CATEGORIES.some((category) => category.id === entry.category)) continue;
    const item: Item = {
      path: entry.displayPath,
      size: entry.logicalBytes,
      dir: entry.type === "directory",
      kind: itemKind(entry.type),
    };
    items[entry.category].push(item);
    sizes[entry.category] += entry.logicalBytes;
  }
  for (const list of Object.values(items)) list.sort((left, right) => right.size - left.size);
  if (totals) {
    for (const category of CATEGORIES) sizes[category.id] = totals.categoryBytes[category.id] ?? 0;
  }
  const measured = totals?.measuredBytes ?? entries.reduce((total, entry) => total + entry.logicalBytes, 0);
  const snapshot: ScanSnapshot = {
    phase,
    total: volume.totalBytes,
    used: volume.usedBytes,
    available: volume.availableBytes,
    measured,
    sizes,
    items,
    current,
    blocked: errors.map((issue) => issue.displayPath),
  };
  if (error) snapshot.error = error;
  return snapshot;
}

/**
 * Development-only adapter from the Rust NDJSON scanner to the existing
 * ScanSnapshot interface. It does not replace the TypeScript scanner.
 */
export function startRustScan(layout: Layout, onUpdate: (snapshot: ScanSnapshot) => void, options: RustScanOptions): ScanHandle {
  if (process.platform !== "win32") throw new Error("the Rust scanner is only available on Windows");
  let cancelled = false;
  let scanner: RustScannerHandle | null = null;
  const entries: RustEntry[] = [];
  const issues: RustIssue[] = [];
  let current = "";
  let volume = {
    id: layout.drive.id,
    mount: layout.drive.mount,
    totalBytes: layout.drive.capacity ?? 0,
    usedBytes: 0,
    availableBytes: layout.drive.freeSpace ?? 0,
  };
  const done = (async (): Promise<ScanSnapshot> => {
    try {
      const space = await diskSpace(layout.drive);
      volume = {
        id: layout.drive.id,
        mount: layout.drive.mount,
        totalBytes: space.total || layout.drive.capacity || 0,
        usedBytes: space.used,
        availableBytes: space.available,
      };
      if (cancelled) {
        const snapshot = snapshotFrom([], [], volume, "cancelled");
        onUpdate(snapshot);
        return snapshot;
      }
      const skipPaths = layout.drive.mounts
        .map((mount) => mount.point)
        .filter((path) => normalPath(path) !== normalPath(layout.drive.mount));
      const request: RustScanRequest = {
        type: "scan_request",
        schemaVersion: "1.0",
        requestId: randomUUID(),
        roots: layout.roots.map((root) => ({ path: root.path, category: root.category })),
        skipPaths,
        foreignPaths: [],
        volume,
        options: {
          batchSize: Math.max(1, Math.min(1_000, options.batchSize ?? 200)),
          threads: Math.max(1, options.threads ?? 6),
          collectEntries: true,
        },
      };
      onUpdate(snapshotFrom(entries, issues, volume, "scanning"));
      scanner = launchRustScanner(request, {
        executable: options.executable,
        timeoutMs: options.timeoutMs,
        onEvent: (event) => {
          const value = event as { type?: string; entries?: unknown; root?: unknown; path?: unknown };
          if (value.type === "entries_batch" && Array.isArray(value.entries)) {
            for (const entry of value.entries) {
              if (entry && typeof entry === "object") entries.push(entry as RustEntry);
            }
            onUpdate(snapshotFrom(entries, issues, volume, "scanning", current));
          } else if (value.type === "progress") {
            current = typeof value.root === "string" ? value.root : "";
          } else if (value.type === "scan_error" || value.type === "scan_warning") {
            const issue = value as unknown as RustIssue;
            if (issue.displayPath && issue.pathKey) issues.push(issue);
          }
        },
      });
      const result = await scanner.result;
      const final = snapshotFrom(
        result.entries,
        result.errors,
        volume,
        result.phase,
        "",
        result.error ?? undefined,
        { measuredBytes: result.summary.measuredBytes, categoryBytes: result.summary.categoryBytes },
      );
      onUpdate(final);
      return final;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = snapshotFrom(entries, issues, volume, "failed", "", message);
      onUpdate(failed);
      return failed;
    }
  })();
  return {
    cancel() {
      cancelled = true;
      scanner?.cancel();
    },
    done,
  };
}

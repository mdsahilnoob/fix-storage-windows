import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { isWhole } from "../classify";
import type { Culprit } from "../browse";
import type { Item } from "../scan";
import { extendedPath, windowsEntryKind } from "./paths";

export interface WindowsDuResult {
  bytes: number;
  denied: boolean;
}

export type Cancelled = () => boolean;

function denied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

async function mapLimit<T, R>(values: T[], limit: number, work: (value: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      result[index] = await work(values[index]);
    }
  });
  await Promise.all(workers);
  return result;
}

class IoLimiter {
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((done) => this.waiting.push(done));
    this.active++;
    try {
      return await work();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

interface Measured {
  bytes: number;
  denied: boolean;
  reparse: boolean;
}

/**
 * Measures a file or folder without following symbolic links, junctions, or
 * other reparse-point directories. File I/O is bounded and every failure is
 * isolated so files can disappear during a live scan.
 */
async function measureEntry(path: string, isCancelled: Cancelled, limiter: IoLimiter): Promise<Measured> {
  if (isCancelled()) return { bytes: 0, denied: false, reparse: false };
  let stat;
  try {
    stat = await limiter.run(() => fsp.lstat(extendedPath(path), { bigint: true }));
  } catch (error) {
    return { bytes: 0, denied: denied(error), reparse: false };
  }
  if (stat.isSymbolicLink()) return { bytes: Number(stat.size), denied: false, reparse: true };
  if (!stat.isDirectory()) return { bytes: Number(stat.size), denied: false, reparse: false };

  let entries;
  try {
    entries = await limiter.run(() => fsp.readdir(extendedPath(path), { withFileTypes: true }));
  } catch (error) {
    return { bytes: 0, denied: denied(error), reparse: false };
  }

  let bytes = 0;
  let deniedAny = false;
  // Iterative work batches avoid both a large Promise queue and synchronous
  // filesystem calls. Each nested measure still yields to the event loop.
  for (let offset = 0; offset < entries.length && !isCancelled(); offset += 24) {
    const batch = entries.slice(offset, offset + 24);
    const measured = await mapLimit(batch, 6, async (entry) => measureEntry(join(path, entry.name), isCancelled, limiter));
    for (const item of measured) {
      bytes += item.bytes;
      deniedAny ||= item.denied;
    }
  }
  return { bytes, denied: deniedAny, reparse: false };
}

export async function windowsDu(path: string, isCancelled: Cancelled = () => false): Promise<WindowsDuResult> {
  const result = await measureEntry(path, isCancelled, new IoLimiter(12));
  return { bytes: result.bytes, denied: result.denied };
}

export async function windowsFileSize(path: string, limiter?: IoLimiter): Promise<number> {
  try {
    const stat = await (limiter ?? new IoLimiter(1)).run(() => fsp.lstat(extendedPath(path), { bigint: true }));
    return Number(stat.size);
  } catch {
    return 0;
  }
}

interface TreeNode {
  path: string;
  bytes: number;
  best?: TreeNode;
  biggestFile?: Item;
  top: Item[];
}

/**
 * One depth-limited walk for culprit discovery. Only the dominant branch and
 * three largest direct children per visited folder are retained, rather than
 * a full in-memory filesystem tree.
 */
async function culpritTree(path: string, depth: number, isCancelled: Cancelled, limiter: IoLimiter): Promise<TreeNode> {
  const empty: TreeNode = { path, bytes: 0, top: [] };
  if (isCancelled() || depth < 0 || (await windowsEntryKind(path)) !== "directory") return empty;
  let entries;
  try {
    entries = await limiter.run(() => fsp.readdir(extendedPath(path), { withFileTypes: true }));
  } catch {
    return empty;
  }

  const node: TreeNode = { path, bytes: 0, top: [] };
  for (let offset = 0; offset < entries.length && !isCancelled(); offset += 12) {
    const children = await mapLimit(entries.slice(offset, offset + 12), 4, async (entry): Promise<{ branch?: TreeNode; file?: Item }> => {
      const child = join(path, entry.name);
      if (isCancelled()) return {};
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (depth === 0) {
          const measured = await measureEntry(child, isCancelled, limiter);
          return { branch: { path: child, bytes: measured.bytes, top: [] } };
        }
        return { branch: await culpritTree(child, depth - 1, isCancelled, limiter) };
      }
      const bytes = await windowsFileSize(child, limiter);
      return { file: { path: child, size: bytes, dir: false } };
    });

    for (const child of children) {
      if (child.branch) {
        const branch = child.branch;
        node.bytes += branch.bytes;
        node.top.push({ path: branch.path, size: branch.bytes, dir: true });
        if (!node.best || branch.bytes > node.best.bytes) node.best = branch;
      } else if (child.file) {
        node.bytes += child.file.size;
        node.top.push(child.file);
        if (!node.biggestFile || child.file.size > node.biggestFile.size) node.biggestFile = child.file;
      }
    }
    node.top = node.top.sort((a, b) => b.size - a.size).slice(0, 3);
    // Non-dominant branches from this batch now have no references and can be
    // garbage-collected before the next batch is measured.
  }
  return node;
}

export function findWindowsCulprit(path: string, onDone: (culprit: Culprit) => void): { cancel(): void } {
  let cancelled = false;
  const isCancelled = () => cancelled;
  const run = async () => {
    const tree = await culpritTree(path, 12, isCancelled, new IoLimiter(12));
    if (cancelled) return;
    const chain: Item[] = [];
    let current = tree;
    for (let depth = 0; depth < 12 && current.best; depth++) {
      const best = current.best;
      if (best.bytes < current.bytes * 0.5) break;
      const item = { path: best.path, size: best.bytes, dir: true };
      chain.push(item);
      current = best;
      if (isWhole(best.path)) break;
    }
    const last = chain[chain.length - 1];
    if ((!last || !isWhole(last.path)) && current.biggestFile && current.biggestFile.size >= current.bytes * 0.5) {
      chain.push(current.biggestFile);
    }
    onDone({ chain, top: tree.top });
  };
  void run();
  return { cancel: () => (cancelled = true) };
}


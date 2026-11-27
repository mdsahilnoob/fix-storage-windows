import { promises as fsp } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { CategoryId } from "./categories";
import type { Layout } from "./layout";
import { IS_MAC, IS_WINDOWS } from "./platform";
import { cannotRemove } from "./browse";
import { recycleWindows, type TrashResult } from "./windows/trash";
import { extendedPath, normalPath, windowsEntryKind } from "./windows/paths";
import { windowsDu } from "./windows/scan";
import type { Item } from "./scan";
import { forgetTrashInfo } from "./trash";

export type Clearable = Extract<CategoryId, "caches" | "trash">;

export interface CleanProgress {
  /** Path that was just handled. */
  path: string;
  /** Observed net free-space bytes; 0 for Recycle Bin moves. */
  freed: number;
  /** Estimated logical bytes moved into the Windows Recycle Bin. */
  movedToRecycleBinBytes?: number;
}

export interface CleanOptions {
  /** Go through the motions without deleting anything. */
  dryRun?: boolean;
  onProgress?: (progress: CleanProgress) => void;
}

/** A definite failure is distinct from an outcome that cannot be established. */
export interface CleanIssue {
  path: string;
  error: string;
  outcome: "failed" | "unknown";
}

export interface CleanResult {
  /** Net free-space increase observed from fresh filesystem measurements; not attributed solely to this app. */
  freed: number;
  /** Estimated logical bytes placed in the Windows Recycle Bin; no space reclaimed yet. */
  movedToRecycleBinBytes: number;
  /** Count of successfully recycled items; not permanent removals. */
  removed: number;
  /** Paths that could not be removed (in use, or protected by the system). */
  skipped: string[];
  /** Paths whose native outcome could not be established; require inspection. */
  unknown: string[];
  /** Windows error details, tagged as a definite failure or an unknown outcome. */
  errors?: CleanIssue[];
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * Everything directly inside the category's folders: the things that would be
 * removed. Sizes come from the scan where it measured them.
 */
export async function plan(category: Clearable, known: Item[], layout: Layout): Promise<Item[]> {
  const keyOf = (path: string) => IS_WINDOWS ? normalPath(path) : path;
  const sizes = new Map(known.map((item) => [keyOf(item.path), item.size]));
  const details = new Map(known.map((item) => [keyOf(item.path), item]));
  const all = layout.roots;
  const rootPaths = new Set(all.map((r) => IS_WINDOWS ? normalPath(r.path) : r.path));
  const items: Item[] = [];
  for (const root of all) {
    if (root.category !== category) continue;
    if (IS_WINDOWS && (await windowsEntryKind(root.path)) !== "directory") continue;
    let names: string[];
    try {
      names = await fsp.readdir(root.path);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(root.path, name);
      if (rootPaths.has(IS_WINDOWS ? normalPath(path) : path) || layout.skip(path)) continue;
      const key = keyOf(path);
      let bytes = sizes.get(key);
      let directory = details.get(key)?.dir;
      if (bytes === undefined || directory === undefined) {
        try {
          const stat = await fsp.lstat(IS_WINDOWS ? extendedPath(path) : path);
          directory = stat.isDirectory() && !stat.isSymbolicLink();
          if (bytes === undefined) bytes = IS_WINDOWS ? (directory ? (await windowsDu(path)).bytes : Number(stat.size)) : stat.blocks * 512;
        } catch {
          continue;
        }
      }
      if (bytes === undefined) continue;
      items.push({ path, size: bytes, dir: directory });
    }
  }
  return items.sort((a, b) => b.size - a.size);
}

/** True only for a path strictly inside one of the category's own folders. */
function inside(category: Clearable, path: string, layout: Layout): boolean {
  const target = IS_WINDOWS ? normalPath(path) : resolve(path);
  return layout.roots.some((root) => {
    if (root.category !== category) return false;
    const parent = IS_WINDOWS ? normalPath(root.path) : resolve(root.path);
    return target.startsWith(parent + (IS_WINDOWS ? "\\" : sep));
  });
}

export async function clean(category: Clearable, items: Item[], layout: Layout, options: CleanOptions = {}): Promise<CleanResult> {
  if (IS_WINDOWS && !options.dryRun) return cleanWindows(category, items, layout, options);
  const result: CleanResult = { freed: 0, movedToRecycleBinBytes: 0, removed: 0, skipped: [], unknown: [] };

  for (const item of items) {
    let freed = 0;
    if (layout.lookOnly || !inside(category, item.path, layout) || layout.foreign(item.path)) {
      result.skipped.push(item.path);
    } else if (options.dryRun) {
      await sleep(25 + Math.min(120, item.size / 2e7));
      if (IS_WINDOWS) result.movedToRecycleBinBytes += item.size;
      else freed = item.size;
    } else {
      try {
        await fsp.rm(item.path, { recursive: true, force: true });
        if (!IS_MAC && category === "trash") await forgetTrashInfo(item.path);
        freed = item.size;
      } catch {
        // In use or protected. Whatever was removed before the failure is
        // picked up when the category is measured again afterwards.
        result.skipped.push(item.path);
      }
    }
    if (freed > 0) {
      result.freed += freed;
      result.removed += 1;
    }
    options.onProgress?.({
      path: item.path,
      freed,
      movedToRecycleBinBytes: IS_WINDOWS && options.dryRun ? item.size : 0,
    });
  }
  return result;
}

/** Windows bulk cleanup has one Recycle Bin provider and no permanent-delete branch. */
async function cleanWindows(category: Clearable, items: Item[], layout: Layout, options: CleanOptions): Promise<CleanResult> {
  const result: CleanResult = { freed: 0, movedToRecycleBinBytes: 0, removed: 0, skipped: [], unknown: [], errors: [] };
  const allowed: Item[] = [];
  for (const item of items) {
    const reason = layout.lookOnly || !inside(category, item.path, layout) || layout.foreign(item.path) ? "Outside the permitted cleanup roots." : cannotRemove(item.path, layout);
    if (reason) {
      result.skipped.push(item.path);
      result.errors?.push({ path: item.path, error: reason, outcome: "failed" });
      options.onProgress?.({ path: item.path, freed: 0, movedToRecycleBinBytes: 0 });
    } else allowed.push(item);
  }
  if (allowed.length === 0) return result;
  let recycled: TrashResult;
  try {
    recycled = await recycleWindows(allowed.map((item) => item.path), layout);
  } catch (error) {
    // The native process may have completed operations before any IPC failure.
    const message = error instanceof Error ? error.message : String(error);
    for (const item of allowed) {
      result.unknown.push(item.path);
      result.errors?.push({ path: item.path, error: `${message} Manual inspection is required.`, outcome: "unknown" });
      options.onProgress?.({ path: item.path, freed: 0, movedToRecycleBinBytes: 0 });
    }
    return result;
  }
  const failed = new Map(recycled.failed.map((failure) => [normalPath(failure.path), failure.error]));
  for (const item of recycled.unknown) {
    result.unknown.push(item.path);
    result.errors?.push({ path: item.path, error: item.error, outcome: "unknown" });
    options.onProgress?.({ path: item.path, freed: 0, movedToRecycleBinBytes: 0 });
  }
  const unknownPaths = new Set(result.unknown.map((path) => normalPath(path)));
  // Positive evidence only: an item is successful if the provider explicitly
  // reported it as moved, not merely because it is absent from the failure map.
  const moved = new Set(recycled.moved.map((path) => normalPath(path)));
  for (const item of allowed) {
    const key = normalPath(item.path);
    if (unknownPaths.has(key)) continue;
    const error = failed.get(key) ?? (moved.has(key) ? undefined : "Windows did not confirm this item was recycled.");
    if (error) {
      result.skipped.push(item.path);
      result.errors?.push({ path: item.path, error, outcome: "failed" });
      options.onProgress?.({ path: item.path, freed: 0, movedToRecycleBinBytes: 0 });
    } else {
      result.movedToRecycleBinBytes += item.size;
      result.removed++;
      options.onProgress?.({ path: item.path, freed: 0, movedToRecycleBinBytes: item.size });
    }
  }
  return result;
}

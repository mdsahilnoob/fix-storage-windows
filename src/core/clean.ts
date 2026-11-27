import { promises as fsp } from "node:fs";
import { join } from "node:path";
import type { CategoryId } from "./categories";
import type { Layout } from "./layout";
import { IS_WINDOWS } from "./platform";
import { extendedPath, normalPath, windowsEntryKind } from "./windows/paths";
import { windowsDu } from "./windows/scan";
import type { Item } from "./scan";

/**
 * v1 is read-only. This module prepares items for recommendations; it never
 * deletes, moves, recycles, renames or modifies anything.
 */
export type Reviewable = Extract<CategoryId, "caches" | "trash">;

export interface ReviewProgress {
  path: string;
  bytes: number;
}

export interface ReviewOptions {
  onProgress?: (progress: ReviewProgress) => void;
}

/** Direct children of reviewable roots, using existing scan sizes where possible. */
export async function plan(category: Reviewable, known: Item[], layout: Layout, options: ReviewOptions = {}): Promise<Item[]> {
  const keyOf = (path: string) => IS_WINDOWS ? normalPath(path) : path;
  const sizes = new Map(known.map((item) => [keyOf(item.path), item.size]));
  const details = new Map(known.map((item) => [keyOf(item.path), item]));
  const all = layout.roots;
  const rootPaths = new Set(all.map((root) => keyOf(root.path)));
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
      const key = keyOf(path);
      if (rootPaths.has(key) || layout.skip(path)) continue;
      let bytes = sizes.get(key);
      let directory = details.get(key)?.dir;
      if (bytes === undefined || directory === undefined) {
        try {
          const stat = await fsp.lstat(IS_WINDOWS ? extendedPath(path) : path);
          directory = stat.isDirectory() && !stat.isSymbolicLink();
          if (bytes === undefined) bytes = IS_WINDOWS && directory ? (await windowsDu(path)).bytes : IS_WINDOWS ? Number(stat.size) : stat.blocks * 512;
        } catch {
          continue;
        }
      }
      if (bytes === undefined) continue;
      items.push({ path, size: bytes, dir: directory });
      options.onProgress?.({ path, bytes });
    }
  }
  return items.sort((a, b) => b.size - a.size);
}

/** Estimated bytes that a user could review; never reported as reclaimed space. */
export function estimate(items: Item[]): number {
  return items.reduce((total, item) => total + item.size, 0);
}

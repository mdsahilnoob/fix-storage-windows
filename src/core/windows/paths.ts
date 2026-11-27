import { promises as fsp } from "node:fs";
import { parse, resolve, sep } from "node:path";

/** Windows paths are compared case-insensitively and with one separator style. */
export function normalPath(path: string): string {
  let full = resolve(path);
  if (full.startsWith("\\\\?\\UNC\\")) full = `\\\\${full.slice(8)}`;
  else if (full.startsWith("\\\\?\\")) full = full.slice(4);
  return full.replace(/[\\/]+/g, "\\").replace(/\\$/, "").toLowerCase();
}

export function samePath(a: string, b: string): boolean {
  return normalPath(a) === normalPath(b);
}

export function insidePath(path: string, folder: string): boolean {
  const target = normalPath(path);
  const parent = normalPath(folder);
  return target.startsWith(parent + "\\");
}

export function atOrInside(path: string, folder: string): boolean {
  return samePath(path, folder) || insidePath(path, folder);
}

export function driveRoot(path: string): string {
  return parse(resolve(path)).root;
}

export function isDriveRoot(path: string): boolean {
  return samePath(path, driveRoot(path));
}

/** Node accepts extended-length paths while the UI keeps the ordinary path. */
export function extendedPath(path: string): string {
  const full = resolve(path);
  if (full.length < 240 || full.startsWith("\\\\?\\")) return full;
  if (full.startsWith("\\\\")) return `\\\\?\\UNC\\${full.slice(2)}`;
  return `\\\\?\\${full}`;
}

export type WindowsEntryKind = "directory" | "file" | "link" | "missing";

/**
 * Examines the entry itself before a caller opens it as a directory. Junctions
 * and symbolic links are reported as links so they are never traversed.
 */
export async function windowsEntryKind(path: string): Promise<WindowsEntryKind> {
  try {
    const stat = await fsp.lstat(extendedPath(path));
    if (stat.isSymbolicLink()) return "link";
    if (stat.isDirectory()) return "directory";
    return "file";
  } catch {
    return "missing";
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await fsp.lstat(extendedPath(path));
    return true;
  } catch {
    return false;
  }
}

/** Deduplicate nested or repeated roots without resolving junction targets. */
export function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const key = normalPath(path);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolve(path));
  }
  return result;
}

export function childPath(parent: string, name: string): string {
  return resolve(parent, `.${sep}${name}`);
}

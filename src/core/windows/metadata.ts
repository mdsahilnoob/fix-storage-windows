import { promises as fsp } from "node:fs";
import type { Usage } from "../classify";
import { extendedPath } from "./paths";

/**
 * NTFS last-access updates can be disabled or delayed, and scanning itself can
 * affect them. Only modification time is reported; it is never called "opened".
 */
export async function windowsUsage(paths: string[]): Promise<Map<string, Usage>> {
  const result = new Map<string, Usage>();
  for (const path of paths) {
    try {
      const stat = await fsp.stat(extendedPath(path));
      result.set(path, { at: stat.mtimeMs, kind: "changed" });
    } catch {
      // The item vanished or is not readable.
    }
  }
  return result;
}

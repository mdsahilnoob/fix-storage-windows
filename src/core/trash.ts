import { homedir } from "node:os";
import { join } from "node:path";
import { homeTrash } from "./layout";
import { IS_MAC, IS_WINDOWS } from "./platform";

/**
 * v1 is read-only. This module only describes where Trash/Recycle Bin storage
 * is located for reporting; it never creates, moves, deletes or modifies it.
 */
export function trashLocation(path: string, home: string = homedir()): string {
  if (IS_WINDOWS) return "Windows Recycle Bin ($Recycle.Bin)";
  if (IS_MAC) return join(home, ".Trash");
  return homeTrash(home);
}

export function trashDescription(): string {
  return IS_WINDOWS
    ? "Recycle Bin usage is reported only. Use Windows storage settings to review it yourself."
    : IS_MAC
      ? "Trash usage is reported only. Use Finder to review it yourself."
      : "Trash usage is reported only. Use your file manager to review it yourself.";
}

/** Operating-system differences are named here instead of scattered through the UI. */

export const IS_MAC = process.platform === "darwin";
export const IS_WINDOWS = process.platform === "win32";
export const IS_LINUX = process.platform === "linux";
export const IS_X64 = process.arch === "x64";

/** The operating system's name, for messages. */
export const OS_NAME = IS_MAC ? "macOS" : IS_WINDOWS ? "Windows" : "Linux";

/** What revealing an item opens, for messages: "Showing x in Explorer." */
export const FILE_MANAGER = IS_MAC ? "Finder" : IS_WINDOWS ? "Explorer" : "your file manager";

/** Lowercase label for the reveal action. */
export const REVEAL_LABEL = IS_MAC ? "reveal in finder" : IS_WINDOWS ? "show in explorer" : "show in file manager";

/** Name of already-deleted storage locations that v1 reports but never changes. */
export const TRASH_NAME = IS_WINDOWS ? "Windows Recycle Bin" : "Trash";

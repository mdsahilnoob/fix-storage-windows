import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import { dirname } from "node:path";
import { extendedPath } from "./paths";

/** Opens Explorer without passing filenames through a command shell. */
export async function revealWindows(path: string): Promise<void> {
  const stat = await fsp.stat(extendedPath(path));
  await new Promise<void>((done, fail) => {
    const args = stat.isDirectory() ? [path] : [`/select,"${path}"`];
    const child = spawn("explorer.exe", args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      windowsVerbatimArguments: !stat.isDirectory(),
    });
    child.on("error", fail);
    child.on("spawn", () => {
      child.unref();
      done();
    });
  });
}

export async function openWindowsFolder(path: string): Promise<void> {
  const stat = await fsp.stat(extendedPath(path));
  if (!stat.isDirectory()) return revealWindows(dirname(path));
  return revealWindows(path);
}

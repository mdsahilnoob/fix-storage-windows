import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import { resolve } from "node:path";
import type { Layout } from "../layout";
import { extendedPath } from "./paths";
import { validateWindowsRecycle } from "./permissions";

export interface TrashFailure {
  path: string;
  error: string;
}

export interface TrashResult {
  moved: string[];
  failed: TrashFailure[];
}

export interface TrashProvider {
  moveToTrash(paths: string[]): Promise<TrashResult>;
}

interface ShellResult {
  Path: string;
  Success: boolean;
  Error?: string | null;
}

const SCRIPT = resolve(__dirname, "../../../scripts/windows-recycle-bin.ps1");

/** The only low-level Windows cleanup provider; callers must use recycleWindows. */
const windowsTrash: TrashProvider = {
  async moveToTrash(paths: string[]): Promise<TrashResult> {
    if (paths.length === 0) return { moved: [], failed: [] };
    const results = await new Promise<ShellResult[]>((done, fail) => {
      const child = spawn(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", SCRIPT],
        { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => {
        if (stderr.length < 64 * 1024) stderr += chunk;
      });
      child.on("error", fail);
      child.on("close", (code) => {
        if (code !== 0) return fail(new Error(stderr.trim() || `Windows Recycle Bin operation exited with code ${code}. No fallback was attempted.`));
        try {
          const parsed = JSON.parse(stdout) as ShellResult[] | ShellResult;
          done(Array.isArray(parsed) ? parsed : [parsed]);
        } catch {
          fail(new Error("Windows Recycle Bin returned an unreadable result. No fallback was attempted."));
        }
      });
      child.stdin.on("error", (error) => child.destroy(error));
      child.stdin.end(JSON.stringify(paths), "utf8");
    });

    const byPath = new Map(results.map((result) => [result.Path, result]));
    const moved: string[] = [];
    const failed: TrashFailure[] = [];
    for (const path of paths) {
      const result = byPath.get(path);
      if (!result?.Success) {
        failed.push({ path, error: result?.Error || "Windows did not confirm a Recycle Bin destination. Manual inspection is required; no fallback was attempted." });
        continue;
      }
      try {
        await fsp.lstat(extendedPath(path));
        failed.push({ path, error: "Shell confirmed a Recycle Bin item, but the source path still exists. Manual inspection is required." });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") moved.push(path);
        else failed.push({ path, error: `Shell confirmed recycling, but the source could not be checked: ${(error as Error).message}` });
      }
    }
    return { moved, failed };
  },
};

/** Validates every item before starting a batch; no permanent-delete fallback exists. */
export async function recycleWindows(paths: string[], layout: Layout): Promise<TrashResult> {
  const valid: string[] = [];
  const failed: TrashFailure[] = [];
  for (const path of paths) {
    try {
      await validateWindowsRecycle(path, layout);
      valid.push(path);
    } catch (error) {
      failed.push({ path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const result = await windowsTrash.moveToTrash(valid);
  return { moved: result.moved, failed: [...failed, ...result.failed] };
}

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
/** Fail closed if a batch produces an implausibly large native result. */
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;

function isShellResult(value: unknown): value is ShellResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return typeof result.Path === "string" &&
    typeof result.Success === "boolean" &&
    (result.Error === undefined || result.Error === null || typeof result.Error === "string");
}

function parseResults(raw: string, paths: string[]): ShellResult[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const results = Array.isArray(parsed) ? parsed : [parsed];
  if (results.length !== paths.length || !results.every(isShellResult)) return null;
  const expected = new Set(paths);
  if (results.some((result) => !expected.has(result.Path))) return null;
  return results;
}

/** The only low-level Windows cleanup provider; callers must use recycleWindows. */
const windowsTrash: TrashProvider = {
  async moveToTrash(paths: string[]): Promise<TrashResult> {
    if (paths.length === 0) return { moved: [], failed: [] };
    const results = await new Promise<ShellResult[]>((resolvePromise, rejectPromise) => {
      const child = spawn(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", SCRIPT],
        { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
      );
      let stdout = "";
      let stdoutBytes = 0;
      let stderr = "";
      let settled = false;
      const rejectOnce = (error: Error) => {
        if (settled) return;
        settled = true;
        rejectPromise(error);
      };
      const resolveOnce = (value: ShellResult[]) => {
        if (settled) return;
        settled = true;
        resolvePromise(value);
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBytes += Buffer.byteLength(chunk, "utf8");
        if (stdoutBytes > MAX_STDOUT_BYTES) {
          child.kill();
          rejectOnce(new Error("Windows Recycle Bin returned too much data. No fallback was attempted."));
          return;
        }
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        if (stderr.length < 64 * 1024) stderr += chunk;
      });
      child.on("error", rejectOnce);
      child.on("close", (code) => {
        if (settled) return;
        if (code !== 0) return rejectOnce(new Error(stderr.trim() || `Windows Recycle Bin operation exited with code ${code}. No fallback was attempted.`));
        const parsed = parseResults(stdout, paths);
        if (parsed) resolveOnce(parsed);
        else rejectOnce(new Error("Windows Recycle Bin returned an unreadable or incomplete result. No fallback was attempted."));
      });
      child.stdin.on("error", (error) => {
        child.kill();
        rejectOnce(new Error(`Could not send cleanup paths to Windows: ${error.message}. No fallback was attempted.`));
      });
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

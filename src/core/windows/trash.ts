import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import { resolve } from "node:path";
import type { Layout } from "../layout";
import { extendedPath } from "./paths";
import { validateWindowsRecycle } from "./permissions";

export type TrashOutcome = "failed" | "unknown";

export interface TrashFailure {
  path: string;
  error: string;
  /** A definite failure is distinct from an outcome that cannot be established. */
  outcome: TrashOutcome;
}

export interface TrashResult {
  moved: string[];
  failed: TrashFailure[];
  unknown: TrashFailure[];
}

export interface TrashOptions {
  /** Per-batch native process timeout; default is five minutes. */
  timeoutMs?: number;
  /** Cancellation after a batch has started produces an unknown outcome. */
  signal?: AbortSignal;
}

export interface TrashProvider {
  moveToTrash(paths: string[], options?: TrashOptions): Promise<TrashResult>;
}

interface ShellResult {
  Path: string;
  Success: boolean;
  Error?: string | null;
}

interface BatchAttempt {
  results: ShellResult[] | null;
  /** True only after the child process actually started. */
  started: boolean;
  reason?: string;
}

const SCRIPT = resolve(__dirname, "../../../scripts/windows-recycle-bin.ps1");
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const PATHS_PER_BATCH = 100;
const DEFAULT_BATCH_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_BATCH_TIMEOUT_MS = 1000;

function normalizeResultPath(path: string): string {
  return path.replace(/\//g, "\\").toLowerCase();
}

function isShellResult(value: unknown): value is ShellResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  if (typeof result.Path !== "string" || typeof result.Success !== "boolean") return false;
  if (result.Error !== undefined && result.Error !== null && typeof result.Error !== "string") return false;
  // A confirmed recycle must not carry a contradictory error message.
  if (result.Success === true && typeof result.Error === "string" && result.Error.trim() !== "") return false;
  return true;
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

  const requested = paths.map(normalizeResultPath);
  if (new Set(requested).size !== requested.length) return null;
  const returned = results.map((result) => normalizeResultPath(result.Path));
  if (new Set(returned).size !== returned.length) return null;

  const expected = new Set(requested);
  if (returned.some((key) => !expected.has(key))) return null;
  // Equal counts, unique keys and membership together reject missing paths.
  return results;
}

function effectiveTimeout(timeoutMs: number | undefined): number {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
    ? Math.max(MIN_BATCH_TIMEOUT_MS, Math.floor(timeoutMs))
    : DEFAULT_BATCH_TIMEOUT_MS;
}

/** Returns null results only when the native outcome cannot be established. */
function runBatch(paths: string[], timeoutMs: number, signal?: AbortSignal): Promise<BatchAttempt> {
  if (signal?.aborted) {
    return Promise.resolve({ results: null, started: false, reason: "Cleanup was cancelled before the native batch started." });
  }
  return new Promise((resolvePromise) => {
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", SCRIPT],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    let stdout = "";
    let stdoutBytes = 0;
    let stderr = "";
    let started = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const stopChild = () => {
      try {
        child.kill();
      } catch {
        // Nothing else to do; the outcome is already unknown.
      }
    };
    const finish = (attempt: BatchAttempt) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolvePromise(attempt);
    };
    const onAbort = () => {
      stopChild();
      finish({ results: null, started, reason: started ? "Cleanup was cancelled after the native batch started; Shell may already have processed it." : "Cleanup was cancelled before the native batch started." });
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.on("spawn", () => {
      started = true;
    });
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        stopChild();
        finish({ results: null, started: true, reason: "Windows Recycle Bin returned more than the output limit; manual inspection is required." });
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.on("error", (error) => {
      stopChild();
      finish({ results: null, started, reason: error.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish({ results: null, started: true, reason: stderr.trim() || `Windows Recycle Bin process exited with code ${code}.` });
        return;
      }
      const parsed = parseResults(stdout, paths);
      finish({
        results: parsed,
        started: true,
        reason: parsed ? undefined : "Windows Recycle Bin returned malformed, incomplete, duplicate or contradictory results.",
      });
    });
    child.stdin.on("error", (error) => {
      stopChild();
      finish({ results: null, started, reason: error.message });
    });
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      stopChild();
      finish({ results: null, started: true, reason: `Windows Recycle Bin batch timed out after ${timeoutMs} ms; Shell may already have processed it.` });
    }, timeoutMs);
    child.stdin.end(JSON.stringify(paths), "utf8");
  });
}

/** The only low-level Windows cleanup provider; callers must use recycleWindows. */
const windowsTrash: TrashProvider = {
  async moveToTrash(paths: string[], options: TrashOptions = {}): Promise<TrashResult> {
    const moved: string[] = [];
    const failed: TrashFailure[] = [];
    const unknown: TrashFailure[] = [];
    const timeoutMs = effectiveTimeout(options.timeoutMs);

    // Bounded batches keep native output below the limit. Cancellation before a
    // batch starts is a definite failure; cancellation after start is unknown.
    for (let offset = 0; offset < paths.length; offset += PATHS_PER_BATCH) {
      const batch = paths.slice(offset, offset + PATHS_PER_BATCH);
      if (options.signal?.aborted) {
        for (const path of batch) failed.push({ path, error: "Cleanup was cancelled before this batch started.", outcome: "failed" });
        continue;
      }

      const attempt = await runBatch(batch, timeoutMs, options.signal);
      if (!attempt.results) {
        const target = attempt.started ? unknown : failed;
        for (const path of batch) target.push({ path, error: attempt.reason ?? "Native outcome could not be established.", outcome: attempt.started ? "unknown" : "failed" });
        continue;
      }

      const byPath = new Map(attempt.results.map((result) => [normalizeResultPath(result.Path), result]));
      for (const path of batch) {
        const result = byPath.get(normalizeResultPath(path));
        if (!result?.Success) {
          failed.push({ path, error: result?.Error || "Windows did not confirm a Recycle Bin destination. Manual inspection is required; no fallback was attempted.", outcome: "failed" });
          continue;
        }
        try {
          await fsp.lstat(extendedPath(path));
          failed.push({ path, error: "Shell confirmed a Recycle Bin item, but the source path still exists. Manual inspection is required.", outcome: "failed" });
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") moved.push(path);
          else unknown.push({ path, error: `Shell confirmed recycling, but the source could not be checked: ${(error as Error).message}`, outcome: "unknown" });
        }
      }
    }
    return { moved, failed, unknown };
  },
};

/** Validates every item before starting a batch; no permanent-delete fallback exists. */
export async function recycleWindows(paths: string[], layout: Layout, options: TrashOptions = {}): Promise<TrashResult> {
  const valid: string[] = [];
  const failed: TrashFailure[] = [];
  for (const path of paths) {
    try {
      await validateWindowsRecycle(path, layout);
      valid.push(path);
    } catch (error) {
      failed.push({ path, error: error instanceof Error ? error.message : String(error), outcome: "failed" });
    }
  }
  const result = await windowsTrash.moveToTrash(valid, options);
  return { moved: result.moved, failed: [...failed, ...result.failed], unknown: result.unknown };
}

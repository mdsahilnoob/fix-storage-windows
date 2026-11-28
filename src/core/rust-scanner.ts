import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { CategoryId } from "./categories";

/**
 * Development-only adapter for the standalone Rust scanner. This module is not
 * imported by the production store or CLI. Callers must opt in explicitly with
 * an absolute executable path and a development configuration.
 */
export const RUST_SCHEMA_VERSION = "1.0" as const;

export type RustScanPhase = "scanning" | "completed" | "cancelled" | "failed";

export interface RustRoot {
  path: string;
  category: CategoryId;
}

export interface RustVolume {
  id: string;
  mount: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
}

export interface RustScanRequest {
  type: "scan_request";
  schemaVersion: typeof RUST_SCHEMA_VERSION;
  requestId: string;
  roots: RustRoot[];
  skipPaths: string[];
  foreignPaths: string[];
  volume: RustVolume;
  options: {
    batchSize: number;
    threads: number;
    collectEntries: boolean;
  };
}

export interface RustEntry {
  displayPath: string;
  pathKey: string;
  type: "file" | "directory" | "symlink" | "junction" | "reparse" | "unknown";
  logicalBytes: number;
  category: CategoryId;
}

export interface RustIssue {
  displayPath: string;
  pathKey: string;
  kind: "unreadable" | "reparse" | string;
  message: string;
}

export interface RustSummary {
  measuredBytes: number;
  unmeasuredBytes: number;
  categoryBytes: Record<string, number>;
  fileEntries: number;
  directoryEntries: number;
  errorCount: number;
}

export interface RustScanMetrics {
  batches: number;
  entries: number;
  maxBatch: number;
  maxStdBufferedChars: number;
  maxPendingBatches: number;
  parseMs: number;
  validationMs: number;
  assemblyMs: number;
  elapsedMs: number;
}

export interface RustScanResult {
  phase: RustScanPhase;
  partial: boolean;
  error: string | null;
  entries: RustEntry[];
  errors: RustIssue[];
  summary: RustSummary;
  stderr: string;
  cancelled: boolean;
  metrics: RustScanMetrics;
}

export interface RustScannerOptions {
  executable: string;
  args?: string[];
  /** Maximum time for the entire scan, including startup. */
  timeoutMs?: number;
  /** Time to wait after cancellation before force-killing the child. */
  terminationTimeoutMs?: number;
  /** Hard cap on collected entries to keep memory bounded. */
  maxEntries?: number;
  /** Optional development hook for cancellation. */
  onEvent?: (event: unknown) => void;
}

export interface RustScannerHandle {
  result: Promise<RustScanResult>;
  cancel(): void;
}

class RustProtocolError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberField(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RustProtocolError(`invalid ${name}`);
  }
  return value;
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RustProtocolError(`invalid ${name}`);
  }
  return value;
}

function categoryField(value: unknown): CategoryId {
  const category = stringField(value, "category");
  if (!["apps", "developer", "photos", "movies", "documents", "music", "system", "caches", "trash"].includes(category)) {
    throw new RustProtocolError(`unknown category: ${category}`);
  }
  return category as CategoryId;
}

function entryField(value: unknown): RustEntry {
  if (!isRecord(value)) throw new RustProtocolError("invalid entry");
  const type = stringField(value.type, "entry.type");
  if (!["file", "directory", "symlink", "junction", "reparse", "unknown"].includes(type)) {
    throw new RustProtocolError(`unknown entry type: ${type}`);
  }
  return {
    displayPath: stringField(value.displayPath, "entry.displayPath"),
    pathKey: stringField(value.pathKey, "entry.pathKey"),
    type: type as RustEntry["type"],
    logicalBytes: numberField(value.logicalBytes, "entry.logicalBytes"),
    category: categoryField(value.category),
  };
}

function issueField(value: unknown): RustIssue {
  if (!isRecord(value)) throw new RustProtocolError("invalid error entry");
  return {
    displayPath: stringField(value.displayPath, "error.displayPath"),
    pathKey: stringField(value.pathKey, "error.pathKey"),
    kind: stringField(value.kind, "error.kind"),
    message: typeof value.message === "string" ? value.message : "",
  };
}

function summaryField(value: unknown): RustSummary {
  if (!isRecord(value)) throw new RustProtocolError("invalid summary");
  if (!isRecord(value.categoryBytes)) throw new RustProtocolError("invalid categoryBytes");
  const categoryBytes: Record<string, number> = {};
  for (const [key, amount] of Object.entries(value.categoryBytes)) {
    categoryBytes[key] = numberField(amount, `categoryBytes.${key}`);
  }
  return {
    measuredBytes: numberField(value.measuredBytes, "summary.measuredBytes"),
    unmeasuredBytes: numberField(value.unmeasuredBytes, "summary.unmeasuredBytes"),
    categoryBytes,
    fileEntries: numberField(value.fileEntries, "summary.fileEntries"),
    directoryEntries: numberField(value.directoryEntries, "summary.directoryEntries"),
    errorCount: numberField(value.errorCount, "summary.errorCount"),
  };
}

function terminalPhase(type: string): RustScanPhase | null {
  if (type === "scan_completed") return "completed";
  if (type === "scan_cancelled") return "cancelled";
  if (type === "scan_failed") return "failed";
  return null;
}

function emptySummary(): RustSummary {
  return {
    measuredBytes: 0,
    unmeasuredBytes: 0,
    categoryBytes: {},
    fileEntries: 0,
    directoryEntries: 0,
    errorCount: 0,
  };
}

/**
 * Launch the standalone Rust scanner. Shell execution is disabled, stdout is
 * parsed as bounded NDJSON, and early exit without a terminal event is failure.
 */
export function launchRustScanner(request: RustScanRequest, options: RustScannerOptions): RustScannerHandle {
  if (!request.requestId.trim()) throw new Error("requestId must not be empty");
  if (request.schemaVersion !== RUST_SCHEMA_VERSION) throw new Error("unsupported request schemaVersion");
  if (!options.executable || !options.executable.includes("\\")) throw new Error("an absolute executable path is required");

  const maxEntries = options.maxEntries ?? 1_000_000;
  const batchLimit = Math.max(1, Math.min(1_000, request.options.batchSize));
  const startedAt = performance.now();
  const metrics: RustScanMetrics = {
    batches: 0,
    entries: 0,
    maxBatch: 0,
    maxStdBufferedChars: 0,
    maxPendingBatches: 0,
    parseMs: 0,
    validationMs: 0,
    assemblyMs: 0,
    elapsedMs: 0,
  };
  const child: ChildProcessWithoutNullStreams = spawn(options.executable, options.args ?? [], {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let cancelled = false;
  let terminal: { phase: RustScanPhase; error: string | null } | null = null;
  let sequence = 0;
  let entries: RustEntry[] = [];
  let errors: RustIssue[] = [];
  let summary: RustSummary | null = null;
  let stderr = "";
  let stdoutBuffer = "";
  const decoder = new StringDecoder("utf8");
  let settled = false;
  let forceTimer: NodeJS.Timeout | null = null;
  let timeoutTimer: NodeJS.Timeout | null = null;
  let resolveResult!: (result: RustScanResult) => void;
  let rejectResult!: (error: Error) => void;

  const result = new Promise<RustScanResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    if (forceTimer) clearTimeout(forceTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (error) {
      rejectResult(error);
      return;
    }
    if (!summary || !terminal) {
      rejectResult(new Error(cancelled ? "Rust scanner terminated after cancellation without a final event" : "Rust scanner terminated without a final event"));
      return;
    }
    metrics.elapsedMs = performance.now() - startedAt;
    resolveResult({
      phase: terminal.phase,
      partial: terminal.phase !== "completed",
      error: terminal.error,
      entries,
      errors,
      summary,
      stderr,
      cancelled,
      metrics,
    });
  };

  const fail = (error: Error) => {
    finish(error);
    if (!child.killed) child.kill();
  };

  const consume = (line: string) => {
    if (!line.trim()) return;
    let event: unknown;
    const parseStarted = performance.now();
    try {
      event = JSON.parse(line);
    } catch {
      throw new RustProtocolError("invalid JSON event");
    }
    metrics.parseMs += performance.now() - parseStarted;

    const validationStarted = performance.now();
    if (!isRecord(event)) throw new RustProtocolError("event must be an object");
    if (event.schemaVersion !== RUST_SCHEMA_VERSION) throw new RustProtocolError("event schemaVersion mismatch");
    if (event.requestId !== request.requestId) throw new RustProtocolError("event requestId mismatch");
    if (typeof event.type !== "string") throw new RustProtocolError("event type missing");
    const eventSequence = Number(event.sequence);
    if (!Number.isInteger(eventSequence) || eventSequence <= sequence) throw new RustProtocolError("non-monotonic event sequence");
    sequence = eventSequence;
    options.onEvent?.(event);
    const phase = terminalPhase(event.type);
    if (phase) {
      if (terminal) throw new RustProtocolError("duplicate terminal event");
      // A cancellation can race with a scan that has already completed. The
      // terminal event is authoritative; keep `cancelled` as a request flag,
      // but do not turn a legitimate completed result into a protocol failure.
      if (event.type === "scan_completed" && event.summary === undefined) throw new RustProtocolError("completed event missing summary");
      if (event.summary !== undefined) summary = summaryField(event.summary);
      else if (phase === "failed") summary = emptySummary();
      terminal = {
        phase,
        error: typeof event.error === "string" ? event.error : null,
      };
      metrics.validationMs += performance.now() - validationStarted;
      finish();
      return;
    }
    if (event.type === "entries_batch") {
      if (!Array.isArray(event.entries)) throw new RustProtocolError("entries_batch missing entries");
      if (event.entries.length > batchLimit) throw new RustProtocolError("entries_batch exceeds requested batch size");
      metrics.validationMs += performance.now() - validationStarted;
      const assemblyStarted = performance.now();
      metrics.batches++;
      metrics.maxPendingBatches = Math.max(metrics.maxPendingBatches, 1);
      metrics.maxBatch = Math.max(metrics.maxBatch, event.entries.length);
      for (const value of event.entries) {
        if (entries.length >= maxEntries) throw new RustProtocolError("entry limit exceeded");
        entries.push(entryField(value));
      }
      metrics.entries = entries.length;
      metrics.assemblyMs += performance.now() - assemblyStarted;
      return;
    }
    if (event.type === "scan_error" || event.type === "scan_warning") {
      errors.push(issueField(event));
    }
    metrics.validationMs += performance.now() - validationStarted;
  };

  child.stdout.on("data", (chunk: Buffer) => {
    if (settled) return;
    stdoutBuffer += decoder.write(chunk);
    metrics.maxStdBufferedChars = Math.max(metrics.maxStdBufferedChars, stdoutBuffer.length);
    try {
      for (;;) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        consume(line);
        if (settled) break;
      }
      if (stdoutBuffer.length > 1_000_000) throw new RustProtocolError("stdout line buffer exceeded 1 MiB");
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 64_000) stderr += chunk.toString();
  });
  child.on("error", (error) => fail(error));
  child.on("close", (code) => {
    if (settled) return;
    if (terminal?.phase === "completed") {
      finish();
      return;
    }
    fail(new Error(`Rust scanner exited before a valid terminal event (code ${code ?? "null"})`));
  });

  const cancel = () => {
    if (cancelled || settled) return;
    cancelled = true;
    try {
      child.stdin.write(`${JSON.stringify({ type: "cancel", schemaVersion: RUST_SCHEMA_VERSION, requestId: request.requestId })}\n`);
    } catch {
      // The child may already have exited; close/error handling reports it.
    }
    forceTimer = setTimeout(() => {
      if (!settled) {
        fail(new Error("Rust scanner did not acknowledge cancellation before the force-termination fallback"));
      }
    }, options.terminationTimeoutMs ?? 5_000);
  };

  const timeout = options.timeoutMs;
  if (timeout && timeout > 0) {
    timeoutTimer = setTimeout(() => {
      if (!settled) {
        cancelled = true;
        fail(new Error("Rust scanner exceeded its timeout"));
      }
    }, timeout);
  }

  child.stdin.write(`${JSON.stringify(request)}\n`);

  return { result, cancel };
}

import { afterEach, beforeEach, expect, test } from "bun:test";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IS_WINDOWS } from "../src/core/platform";
import { launchRustScanner, type RustScanRequest } from "../src/core/rust-scanner";

let root = "";
const children = new Set<ReturnType<typeof launchRustScanner>>();

beforeEach(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), "fix-storage-adapter-"));
});

afterEach(async () => {
  for (const handle of children) handle.cancel();
  children.clear();
  await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
  root = "";
});

function request(): RustScanRequest {
  return {
    type: "scan_request",
    schemaVersion: "1.0",
    requestId: "adapter-test",
    roots: [{ path: "C:\\fixture", category: "documents" }],
    skipPaths: [],
    foreignPaths: [],
    volume: { id: "v", mount: "C:\\", totalBytes: 100, usedBytes: 50, availableBytes: 50 },
    options: { batchSize: 2, threads: 1, collectEntries: true },
  };
}

async function fake(body: string): Promise<string> {
  const path = join(root, "fake.cjs");
  await fsp.writeFile(path, body);
  return path;
}

function launch(script: string, options: Parameters<typeof launchRustScanner>[1] = { executable: process.execPath }) {
  const handle = launchRustScanner(request(), { ...options, executable: options.executable ?? process.execPath, args: [script] });
  children.add(handle);
  return handle;
}

const completedChild = `
let input = "";
let seq = 0;
let request;
function emit(type, extra = {}) {
  process.stdout.write(JSON.stringify({ schemaVersion: "1.0", requestId: request.requestId, sequence: ++seq, type, ...extra }) + "\\n");
}
process.stdin.on("data", (chunk) => {
  input += chunk.toString();
  const line = input.indexOf("\\n");
  if (line < 0 || request) return;
  request = JSON.parse(input.slice(0, line));
  input = input.slice(line + 1);
  emit("scan_started", { rootCount: 1 });
  emit("entries_batch", { entries: [{ displayPath: "C:\\\\fixture\\\\a.bin", pathKey: "c:\\\\fixture\\\\a.bin", type: "file", logicalBytes: 5, category: "documents" }] });
  emit("scan_completed", { summary: { measuredBytes: 5, unmeasuredBytes: 45, categoryBytes: { documents: 5 }, fileEntries: 1, directoryEntries: 0, errorCount: 0 } });
  setTimeout(() => process.exit(0), 10);
});
`;

const cancelledChild = `
let input = "";
let seq = 0;
let request;
function emit(type, extra = {}) {
  process.stdout.write(JSON.stringify({ schemaVersion: "1.0", requestId: request.requestId, sequence: ++seq, type, ...extra }) + "\\n");
}
process.stdin.on("data", (chunk) => {
  input += chunk.toString();
  for (;;) {
    const line = input.indexOf("\\n");
    if (line < 0) return;
    const text = input.slice(0, line);
    input = input.slice(line + 1);
    const message = JSON.parse(text);
    if (message.type === "scan_request") {
      request = message;
      emit("scan_started", { rootCount: 1 });
    } else if (message.type === "cancel" && request) {
      emit("scan_cancelled", { summary: { measuredBytes: 0, unmeasuredBytes: 50, categoryBytes: { documents: 0 }, fileEntries: 0, directoryEntries: 0, errorCount: 0 } });
      setTimeout(() => process.exit(0), 10);
    }
  }
});
`;

const abruptChild = `
process.stdin.on("data", () => { process.exit(0); });
`;

const malformedChild = `
process.stdout.write("not json\\n");
process.stdin.resume();
`;

test("accepts a completed event and bounded entry batch", async () => {
  if (!IS_WINDOWS) return;
  const script = await fake(completedChild);
  const handle = launch(script);
  const result = await handle.result;
  expect(result.phase).toBe("completed");
  expect(result.partial).toBe(false);
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]?.logicalBytes).toBe(5);
  expect(result.summary.measuredBytes).toBe(5);
});

test("supports cooperative cancellation and returns cancelled with partial state", async () => {
  if (!IS_WINDOWS) return;
  const script = await fake(cancelledChild);
  const handle = launch(script);
  setTimeout(() => handle.cancel(), 50);
  const result = await handle.result;
  expect(result.phase).toBe("cancelled");
  expect(result.partial).toBe(true);
  expect(result.cancelled).toBe(true);
  expect(result.summary.unmeasuredBytes).toBe(50);
});

test("rejects abrupt child termination instead of treating it as success", async () => {
  if (!IS_WINDOWS) return;
  const script = await fake(abruptChild);
  const handle = launch(script);
  await expect(handle.result).rejects.toThrow("exited");
});

test("rejects malformed NDJSON", async () => {
  if (!IS_WINDOWS) return;
  const script = await fake(malformedChild);
  const handle = launch(script);
  await expect(handle.result).rejects.toThrow("invalid JSON");
});

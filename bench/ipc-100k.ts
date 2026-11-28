import { spawnSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATEGORIES } from "../src/core/categories";
import { demoDrives, demoLayout } from "../src/core/demo";
import { launchRustScanner, type RustScanRequest } from "../src/core/rust-scanner";
import { startScan, unmeasuredBytes } from "../src/core/scan";
import { toText } from "../src/plain";
import { normalPath } from "../src/core/windows/paths";

const files = 100_000;
const rustExe = join(import.meta.dir, "..", "scanner-rust", "target", "release", "fix-storage-scanner-rust.exe");

function normalize(report: any) {
  return {
    phase: report.scan?.phase ?? report.phase,
    partial: report.scan?.partial ?? report.partial,
    volume: report.volume
      ? {
          id: report.volume.id,
          mount: normalPath(report.volume.mount),
          totalBytes: report.volume.totalBytes,
          usedBytes: report.volume.usedBytes,
          availableBytes: report.volume.availableBytes,
        }
      : null,
    measuredBytes: report.totals?.measuredBytes ?? report.summary?.measuredBytes,
    unmeasuredBytes: report.totals?.unmeasuredBytes ?? report.summary?.unmeasuredBytes,
    categoryBytes: Object.fromEntries(
      Object.entries(report.totals?.categoryBytes ?? report.summary?.categoryBytes ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    ),
    entries: [...(report.entries ?? [])]
      .map((entry: any) => ({
        pathKey: normalPath(entry.pathKey ?? entry.displayPath),
        type: entry.type ?? entry.kind,
        logicalBytes: entry.logicalBytes,
        category: entry.category,
      }))
      .sort((left, right) => left.pathKey.localeCompare(right.pathKey)),
    errors: [...(report.errors ?? [])]
      .map((error: any) => ({ pathKey: normalPath(error.pathKey ?? error.displayPath), kind: error.kind }))
      .sort((left, right) => left.pathKey.localeCompare(right.pathKey)),
  };
}

async function makeFixture(root: string) {
  for (let start = 0; start < files; start += 1000) {
    const jobs: Promise<void>[] = [];
    for (let index = start; index < Math.min(start + 1000, files); index++) {
      jobs.push(fsp.writeFile(join(root, `file-${String(index).padStart(6, "0")}.bin`), Buffer.alloc(1024, 7)));
    }
    await Promise.all(jobs);
  }
}

async function main() {
  const root = await fsp.mkdtemp(join(tmpdir(), "fix-storage-ipc-100k-"));
  try {
    await makeFixture(root);
    const drive = { ...demoDrives()[0], mount: root, capacity: 1_000_000_000, freeSpace: 900_000_000 };
    const layout = { ...demoLayout(drive), roots: [{ path: root, category: "documents" as const }] };

    const tsCpuBefore = process.cpuUsage();
    let started = performance.now();
    const scan = await startScan(layout, () => {}, { concurrency: 6, throttleMs: 0 }).done;
    const tsScanMs = performance.now() - started;
    const tsCpu = process.cpuUsage(tsCpuBefore);
    const tsEntries = CATEGORIES.flatMap((category) =>
      scan.items[category.id].map((item) => ({
        pathKey: normalPath(item.path),
        type: item.kind ?? (item.dir ? "directory" : "file"),
        logicalBytes: item.size,
        category: category.id,
      })),
    );
    const tsReport = {
      schemaVersion: "1.0",
      scan: { phase: scan.phase, partial: scan.phase !== "completed" },
      volume: { id: drive.id, mount: drive.mount, totalBytes: scan.total, usedBytes: scan.used, availableBytes: scan.available },
      totals: {
        measuredBytes: scan.measured,
        unmeasuredBytes: unmeasuredBytes(scan),
        categoryBytes: scan.sizes,
        fileEntries: tsEntries.filter((entry) => entry.type === "file").length,
        directoryEntries: tsEntries.filter((entry) => entry.type === "directory").length,
        errorCount: scan.blocked.length,
      },
      entries: tsEntries,
      errors: scan.blocked.map((path) => ({ pathKey: normalPath(path), kind: "unreadable" })),
    };
    started = performance.now();
    const tsJson = JSON.stringify(tsReport);
    const tsJsonMs = performance.now() - started;
    started = performance.now();
    toText(scan, layout, 1);
    const tsTextMs = performance.now() - started;

    const request: RustScanRequest = {
      type: "scan_request",
      schemaVersion: "1.0",
      requestId: "ipc-100k",
      roots: [{ path: root, category: "documents" }],
      skipPaths: [],
      foreignPaths: [],
      volume: tsReport.volume,
      options: { batchSize: 200, threads: 6, collectEntries: true },
    };

    let firstEventAt = 0;
    let terminalAt = 0;
    let runtime: unknown = null;
    started = performance.now();
    const adapter = await launchRustScanner(request, {
      executable: rustExe,
      timeoutMs: 120_000,
      onEvent: (event) => {
        const value = event as { type?: string; runtime?: unknown };
        if (value.type === "scan_started" && firstEventAt === 0) firstEventAt = performance.now();
        if (value.type === "scan_completed" || value.type === "scan_cancelled" || value.type === "scan_failed") {
          terminalAt = performance.now();
          runtime = value.runtime ?? null;
        }
      },
    }).result;
    const adapterMs = performance.now() - started;
    const adapterReport = {
      scan: { phase: adapter.phase, partial: adapter.partial },
      volume: tsReport.volume,
      totals: adapter.summary,
      entries: adapter.entries,
      errors: adapter.errors,
    };
    if (JSON.stringify(normalize(adapterReport)) !== JSON.stringify(normalize(tsReport))) {
      throw new Error("100k adapter result does not match TypeScript reference");
    }

    const summaryRequest = { ...request, requestId: "ipc-100k-summary", options: { ...request.options, collectEntries: false } };
    started = performance.now();
    const summaryRun = spawnSync(rustExe, ["--report"], { input: JSON.stringify(summaryRequest), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    const summaryMs = performance.now() - started;
    if (summaryRun.status !== 0) throw new Error(summaryRun.stderr || "Rust summary failed");
    const summaryReport = JSON.parse(summaryRun.stdout);

    const fullRequest = { ...request, requestId: "ipc-100k-full" };
    started = performance.now();
    const fullRun = spawnSync(rustExe, ["--report"], { input: JSON.stringify(fullRequest), encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
    const fullMs = performance.now() - started;
    if (fullRun.status !== 0) throw new Error(fullRun.stderr || "Rust full report failed");

    console.log(JSON.stringify({
      files,
      tsScanMs,
      tsJsonMs,
      tsTextMs,
      tsJsonBytes: Buffer.byteLength(tsJson),
      tsCpuUserMs: tsCpu.user / 1000,
      tsCpuSystemMs: tsCpu.system / 1000,
      parentRssBytes: process.memoryUsage().rss,
      rustAdapterMs: adapterMs,
      rustStartedToTerminalMs: terminalAt > 0 ? terminalAt - firstEventAt : null,
      rustAdapterMetrics: adapter.metrics,
      rustRuntime: runtime,
      rustSummaryMs: summaryMs,
      rustFullReportMs: fullMs,
      rustSerializationMs: fullMs - summaryMs,
      rustSummaryMeasuredBytes: summaryReport.totals.measuredBytes,
      rustFullEntries: JSON.parse(fullRun.stdout).entries.length,
      rustFullPhase: JSON.parse(fullRun.stdout).scan.phase,
      normalizedEqual: true,
      entries: adapter.entries.length,
      batches: adapter.metrics.batches,
    }, null, 2));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});

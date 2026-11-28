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

const shape = { dirs: 100, filesPerDir: 100, bytesPerFile: 1024 };
const reps = 3;
const rustExe = join(import.meta.dir, "..", "scanner-rust", "target", "release", "fix-storage-scanner-rust.exe");

function normalize(report: any) {
  return {
    phase: report.scan?.phase ?? report.phase,
    partial: report.scan?.partial ?? report.partial,
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

function median(values: number[]) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

async function makeFixture(root: string): Promise<number> {
  let files = 0;
  for (let dir = 0; dir < shape.dirs; dir++) {
    const folder = join(root, `dir-${String(dir).padStart(3, "0")}`);
    await fsp.mkdir(folder, { recursive: true });
    for (let index = 0; index < shape.filesPerDir; index++) {
      await fsp.writeFile(join(folder, `file-${String(index).padStart(4, "0")}.bin`), Buffer.alloc(shape.bytesPerFile, 7));
      files++;
    }
  }
  return files;
}

async function main() {
  const root = await fsp.mkdtemp(join(tmpdir(), "fix-storage-e2e-"));
  try {
    const files = await makeFixture(root);
    const drive = { ...demoDrives()[0], mount: root, capacity: 1_000_000_000, freeSpace: 900_000_000 };
    const layout = { ...demoLayout(drive), roots: [{ path: root, category: "documents" as const }] };
    const series = { tsScan: [] as number[], tsJson: [] as number[], tsText: [] as number[], rustSummary: [] as number[], rustFull: [] as number[], adapter: [] as number[] };
    let reference: any;
    let volume: any;
    let lastRuntime: any;
    for (let rep = 0; rep < reps; rep++) {
      const cpuBefore = process.cpuUsage();
      const start = performance.now();
      const scan = await startScan(layout, () => {}, { concurrency: 6, throttleMs: 0 }).done;
      series.tsScan.push(performance.now() - start);
      const cpu = process.cpuUsage(cpuBefore);
      const entries = CATEGORIES.flatMap((category) =>
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
          fileEntries: entries.filter((entry) => entry.type === "file").length,
          directoryEntries: entries.filter((entry) => entry.type === "directory").length,
          errorCount: scan.blocked.length,
        },
        entries,
        errors: scan.blocked.map((path) => ({ pathKey: normalPath(path), kind: "unreadable" })),
      };
      reference ??= normalize(tsReport);
      volume ??= tsReport.volume;

      let started = performance.now();
      const tsJson = JSON.stringify(tsReport);
      series.tsJson.push(performance.now() - started);
      started = performance.now();
      toText(scan, layout, 1);
      series.tsText.push(performance.now() - started);
      if (!tsJson) throw new Error("TypeScript JSON serialization failed");

      const summaryRequest = {
        type: "scan_request",
        schemaVersion: "1.0",
        requestId: `e2e-summary-${rep}`,
        roots: [{ path: root, category: "documents" }],
        skipPaths: [],
        foreignPaths: [],
        volume,
        options: { batchSize: 200, threads: 6, collectEntries: false },
      };
      started = performance.now();
      const summaryRun = spawnSync(rustExe, ["--report"], { input: JSON.stringify(summaryRequest), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      series.rustSummary.push(performance.now() - started);
      if (summaryRun.status !== 0) throw new Error(summaryRun.stderr || "Rust summary failed");
      const summaryReport = JSON.parse(summaryRun.stdout);
      lastRuntime = summaryReport.runtime;

      const fullRequest = { ...summaryRequest, requestId: `e2e-full-${rep}`, options: { ...summaryRequest.options, collectEntries: true } };
      started = performance.now();
      const fullRun = spawnSync(rustExe, ["--report"], { input: JSON.stringify(fullRequest), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      series.rustFull.push(performance.now() - started);
      if (fullRun.status !== 0) throw new Error(fullRun.stderr || "Rust full report failed");
      const fullReport = JSON.parse(fullRun.stdout);
      if (JSON.stringify(normalize(fullReport)) !== JSON.stringify(reference)) throw new Error("Rust full report mismatch");

      const adapterRequest: RustScanRequest = {
        ...fullRequest,
        options: { batchSize: 200, threads: 6, collectEntries: true },
      };
      started = performance.now();
      let batches = 0;
      const adapter = await launchRustScanner(adapterRequest as RustScanRequest, {
        executable: rustExe,
        onEvent: (event) => {
          if ((event as { type?: string }).type === "entries_batch") batches++;
        },
      }).result;
      series.adapter.push(performance.now() - started);
      const adapterReport = {
        scan: { phase: adapter.phase, partial: adapter.partial },
        volume,
        totals: adapter.summary,
        entries: adapter.entries,
        errors: adapter.errors,
      };
      if (JSON.stringify(normalize(adapterReport)) !== JSON.stringify(reference)) throw new Error("Rust adapter mismatch");
      if (batches === 0 && entries.length > 0) throw new Error("Rust adapter emitted no entry batches");
      // Keep CPU / RSS observations in the final report without claiming peak RSS for the parent.
      if (rep === reps - 1) {
        console.log(JSON.stringify({ files, reps, median: {
          tsScanMs: median(series.tsScan),
          tsJsonMs: median(series.tsJson),
          tsTextMs: median(series.tsText),
          rustSummaryMs: median(series.rustSummary),
          rustFullMs: median(series.rustFull),
          adapterMs: median(series.adapter),
          rustSerializationMs: median(series.rustFull) - median(series.rustSummary),
        }, tsCpuUserMs: cpu.user / 1000, tsCpuSystemMs: cpu.system / 1000, parentRssBytes: process.memoryUsage().rss, rustRuntime: lastRuntime, adapterBatchesLast: batches }, null, 2));
      }
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});

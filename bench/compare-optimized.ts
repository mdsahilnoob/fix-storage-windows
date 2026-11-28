import { spawnSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATEGORIES } from "../src/core/categories";
import { demoDrives, demoLayout } from "../src/core/demo";
import { startScan, unmeasuredBytes } from "../src/core/scan";
import { normalPath } from "../src/core/windows/paths";

interface Shape {
  name: string;
  dirs: number;
  filesPerDir: number;
  bytesPerFile: number;
}

const shapes: Shape[] = [
  { name: "flat-1000", dirs: 1, filesPerDir: 1000, bytesPerFile: 4096 },
  { name: "nested-20x20", dirs: 20, filesPerDir: 20, bytesPerFile: 2048 },
  { name: "mixed-10x50", dirs: 10, filesPerDir: 50, bytesPerFile: 8192 },
  { name: "large-100x100", dirs: 100, filesPerDir: 100, bytesPerFile: 1024 },
];

const rustExe = join(import.meta.dir, "..", "scanner-rust", "target", "release", "fix-storage-scanner-rust.exe");
const reps = 3;

function normalize(report: any) {
  return {
    phase: report.scan?.phase ?? report.phase,
    partial: report.scan?.partial ?? report.partial,
    volume: {
      id: report.volume?.id ?? null,
      mount: normalPath(report.volume?.mount ?? ""),
      totalBytes: report.volume?.totalBytes ?? 0,
      usedBytes: report.volume?.usedBytes ?? 0,
      availableBytes: report.volume?.availableBytes ?? 0,
    },
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

async function makeShape(root: string, shape: Shape): Promise<number> {
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

async function tsScan(root: string, concurrency: number) {
  const drive = { ...demoDrives()[0], mount: root, capacity: 1_000_000_000, freeSpace: 900_000_000 };
  const layout = { ...demoLayout(drive), roots: [{ path: root, category: "documents" as const }] };
  const started = performance.now();
  const scan = await startScan(layout, () => {}, { concurrency, throttleMs: 0 }).done;
  const wallMs = performance.now() - started;
  const entries = CATEGORIES.flatMap((category) =>
    scan.items[category.id].map((item) => ({
      pathKey: normalPath(item.path),
      type: item.kind ?? (item.dir ? "directory" : "file"),
      logicalBytes: item.size,
      category: category.id,
    })),
  );
  return {
    wallMs,
    report: {
      schemaVersion: "1.0",
      scan: { phase: scan.phase, partial: scan.phase !== "completed" },
      volume: { id: drive.id ?? "ts-volume", mount: drive.mount, totalBytes: scan.total, usedBytes: scan.used, availableBytes: scan.available },
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
    },
  };
}

function rustScan(root: string, volume: any, threads: number) {
  const request = {
    type: "scan_request",
    schemaVersion: "1.0",
    requestId: `bench-${Date.now()}`,
    roots: [{ path: root, category: "documents" }],
    skipPaths: [],
    foreignPaths: [],
    volume,
    options: { batchSize: 200, threads, collectEntries: true },
  };
  const started = performance.now();
  const run = spawnSync(rustExe, ["--report"], { input: JSON.stringify(request), encoding: "utf8", windowsHide: true, timeout: 120_000 });
  if (run.status !== 0) throw new Error(run.stderr || `Rust scanner exited ${run.status}`);
  return { wallMs: performance.now() - started, report: JSON.parse(run.stdout) };
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const results: any[] = [];
for (const shape of shapes) {
  const root = await fsp.mkdtemp(join(tmpdir(), `fix-storage-optimized-${shape.name}-`));
  try {
    const files = await makeShape(root, shape);
    const series: Record<string, number[]> = { ts1: [], ts6: [], rust: [] };
    for (let round = 0; round < reps; round++) {
      const ts1 = await tsScan(root, 1);
      const ts6 = await tsScan(root, 6);
      const rust = rustScan(root, ts1.report.volume, 6);
      const ts1Normalized = normalize(ts1.report);
      const ts6Normalized = normalize(ts6.report);
      const resultOnly = (value: any) => ({
        ...value,
        volume: null,
        unmeasuredBytes: 0,
        categoryBytes: { ...value.categoryBytes, system: 0 },
      });
      if (JSON.stringify(resultOnly(ts1Normalized)) !== JSON.stringify(resultOnly(ts6Normalized))) throw new Error("TypeScript concurrency mismatch");
      if (JSON.stringify(ts1Normalized) !== JSON.stringify(normalize(rust.report))) {
        const stamp = `${process.pid}-${Date.now()}`;
        const tsFile = join(tmpdir(), `compare-ts-${stamp}.json`);
        const rustFile = join(tmpdir(), `compare-rust-${stamp}.json`);
        await fsp.writeFile(tsFile, JSON.stringify(ts1.report));
        await fsp.writeFile(rustFile, JSON.stringify(rust.report));
        const diff = spawnSync("node", [join(import.meta.dir, "..", "tools", "scanner-differential.mjs"), "--reference", tsFile, "--candidate", rustFile], { encoding: "utf8" });
        await fsp.rm(tsFile, { force: true });
        await fsp.rm(rustFile, { force: true });
        throw new Error(`Rust/TypeScript mismatch:\n${diff.stdout || diff.stderr}`);
      }
      series.ts1.push(ts1.wallMs);
      series.ts6.push(ts6.wallMs);
      series.rust.push(rust.wallMs);
    }
    results.push({
      shape: shape.name,
      files,
      dirs: shape.dirs,
      reps,
      ts1Ms: series.ts1.map((value) => Math.round(value * 100) / 100),
      ts6Ms: series.ts6.map((value) => Math.round(value * 100) / 100),
      rustMs: series.rust.map((value) => Math.round(value * 100) / 100),
      ts1Median: Math.round(median(series.ts1) * 100) / 100,
      ts6Median: Math.round(median(series.ts6) * 100) / 100,
      rustMedian: Math.round(median(series.rust) * 100) / 100,
      speedupVsTs6: Math.round((median(series.ts6) / median(series.rust)) * 100) / 100,
      normalizedEqual: true,
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({ generatedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, reps, results, referenceShape: shapes.map((shape) => shape.name) }, null, 2));

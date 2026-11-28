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
];

const rustExe = join(import.meta.dir, "..", "scanner-rust", "target", "release", "fix-storage-scanner-rust.exe");

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

async function tsScan(root: string) {
  const drive = { ...demoDrives()[0], mount: root, capacity: 1_000_000_000, freeSpace: 900_000_000 };
  const layout = { ...demoLayout(drive), roots: [{ path: root, category: "documents" as const }] };
  const started = performance.now();
  const scan = await startScan(layout, () => {}, { concurrency: 6, throttleMs: 0 }).done;
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
      scan: { phase: scan.phase, partial: scan.phase !== "completed" },
      volume: { id: drive.id ?? "ts-volume", mount: drive.mount, totalBytes: scan.total, usedBytes: scan.used, availableBytes: scan.available },
      totals: {
        measuredBytes: scan.measured,
        unmeasuredBytes: unmeasuredBytes(scan),
        categoryBytes: scan.sizes,
      },
      entries,
      errors: scan.blocked.map((path) => ({ pathKey: normalPath(path), kind: "unreadable" })),
    },
  };
}

function rustScan(root: string, volume: any) {
  const request = {
    type: "scan_request",
    schemaVersion: "1.0",
    requestId: `bench-${Date.now()}`,
    roots: [{ path: root, category: "documents" }],
    skipPaths: [],
    foreignPaths: [],
    volume,
    options: { batchSize: 50, threads: 1, collectEntries: true },
  };
  const started = performance.now();
  const run = spawnSync(rustExe, ["--report"], {
    input: `${JSON.stringify(request)}\n`,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
  const wallMs = performance.now() - started;
  if (run.status !== 0) throw new Error(run.stderr || `Rust scanner exited ${run.status}`);
  return { wallMs, report: JSON.parse(run.stdout) };
}

const results: any[] = [];
for (const shape of shapes) {
  const root = await fsp.mkdtemp(join(tmpdir(), `fix-storage-compare-${shape.name}-`));
  try {
    const files = await makeShape(root, shape);
    const firstTs = await tsScan(root);
    const firstRust = rustScan(root, firstTs.report.volume);
    const secondTs = await tsScan(root);
    const secondRust = rustScan(root, secondTs.report.volume);
    const tsNormalized = normalize(firstTs.report);
    const rustNormalized = normalize(firstRust.report);
    const equal = JSON.stringify(tsNormalized) === JSON.stringify(rustNormalized);
    results.push({
      shape: shape.name,
      files,
      dirs: shape.dirs,
      tsColdMs: Math.round(firstTs.wallMs * 100) / 100,
      rustColdMs: Math.round(firstRust.wallMs * 100) / 100,
      tsWarmMs: Math.round(secondTs.wallMs * 100) / 100,
      rustWarmMs: Math.round(secondRust.wallMs * 100) / 100,
      coldRatio: Math.round((firstTs.wallMs / firstRust.wallMs) * 100) / 100,
      warmRatio: Math.round((secondTs.wallMs / secondRust.wallMs) * 100) / 100,
      normalizedEqual: equal,
      tsMeasured: tsNormalized.measuredBytes,
      rustMeasured: rustNormalized.measuredBytes,
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({ generatedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version, rustExe, results }, null, 2));

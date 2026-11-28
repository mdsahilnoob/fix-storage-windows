import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoDrives, demoLayout } from "../src/core/demo";
import { startScan, type ScanSnapshot } from "../src/core/scan";

type Counters = { readdir: number; lstat: number; statfs: number };

interface Shape {
  name: string;
  dirs: number;
  filesPerDir: number;
  bytesPerFile: number;
}

const shapes: Shape[] = [
  { name: "flat-300-files", dirs: 1, filesPerDir: 300, bytesPerFile: 4096 },
  { name: "nested-20x10", dirs: 20, filesPerDir: 10, bytesPerFile: 2048 },
  { name: "mixed-10x20", dirs: 10, filesPerDir: 20, bytesPerFile: 8192 },
];

const original = {
  readdir: fsp.readdir.bind(fsp),
  lstat: fsp.lstat.bind(fsp),
  statfs: fsp.statfs.bind(fsp),
};
const counters: Counters = { readdir: 0, lstat: 0, statfs: 0 };

function instrument(): void {
  (fsp as unknown as { readdir: typeof fsp.readdir }).readdir = (async (...args: Parameters<typeof fsp.readdir>) => {
    counters.readdir++;
    return original.readdir(...args);
  }) as typeof fsp.readdir;
  (fsp as unknown as { lstat: typeof fsp.lstat }).lstat = (async (...args: Parameters<typeof fsp.lstat>) => {
    counters.lstat++;
    return original.lstat(...args);
  }) as typeof fsp.lstat;
  (fsp as unknown as { statfs: typeof fsp.statfs }).statfs = (async (...args: Parameters<typeof fsp.statfs>) => {
    counters.statfs++;
    return original.statfs(...args);
  }) as typeof fsp.statfs;
}

function restore(): void {
  (fsp as unknown as { readdir: typeof fsp.readdir }).readdir = original.readdir as typeof fsp.readdir;
  (fsp as unknown as { lstat: typeof fsp.lstat }).lstat = original.lstat as typeof fsp.lstat;
  (fsp as unknown as { statfs: typeof fsp.statfs }).statfs = original.statfs as typeof fsp.statfs;
}

async function makeShape(root: string, shape: Shape): Promise<{ files: number; dirs: number }> {
  let files = 0;
  for (let dir = 0; dir < shape.dirs; dir++) {
    const folder = join(root, `dir-${String(dir).padStart(3, "0")}`);
    await fsp.mkdir(folder, { recursive: true });
    for (let index = 0; index < shape.filesPerDir; index++) {
      await fsp.writeFile(join(folder, `file-${String(index).padStart(4, "0")}.bin`), Buffer.alloc(shape.bytesPerFile, 7));
      files++;
    }
  }
  return { files, dirs: shape.dirs };
}

async function scanOnce(root: string): Promise<{ scan: ScanSnapshot; wallMs: number; cpuMs: number; peakRss: number }> {
  const drive = { ...demoDrives()[0], mount: root, capacity: 1_000_000_000, freeSpace: 900_000_000 };
  const layout = { ...demoLayout(drive), roots: [{ path: root, category: "documents" as const }] };
  counters.readdir = 0;
  counters.lstat = 0;
  counters.statfs = 0;
  instrument();
  let peakRss = process.memoryUsage().rss;
  const memory = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 5);
  const before = process.cpuUsage();
  const started = process.hrtime.bigint();
  try {
    const scan = await startScan(layout, () => {}, { concurrency: 6, throttleMs: 0 }).done;
    const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
    const cpu = process.cpuUsage(before);
    return { scan, wallMs, cpuMs: (cpu.user + cpu.system) / 1000, peakRss };
  } finally {
    clearInterval(memory);
    restore();
  }
}

async function cancellationLatency(root: string): Promise<{ latencyMs: number; phase: string; measured: number }> {
  const drive = { ...demoDrives()[0], mount: root, capacity: 1_000_000_000, freeSpace: 900_000_000 };
  const layout = { ...demoLayout(drive), roots: [{ path: root, category: "documents" as const }] };
  let handle!: ReturnType<typeof startScan>;
  let cancelledAt = 0;
  handle = startScan(layout, (snapshot) => {
    if (snapshot.phase === "scanning" && snapshot.measured > 0 && cancelledAt === 0) {
      cancelledAt = performance.now();
      handle.cancel();
    }
  }, { concurrency: 6, throttleMs: 0 });
  const scan = await handle.done;
  return {
    latencyMs: cancelledAt > 0 ? performance.now() - cancelledAt : 0,
    phase: scan.phase,
    measured: scan.measured,
  };
}

const results: unknown[] = [];
for (const shape of shapes) {
  const root = await fsp.mkdtemp(join(tmpdir(), `fix-storage-bench-${shape.name}-`));
  try {
    const fixture = await makeShape(root, shape);
    const cold = await scanOnce(root);
    const coldCounters = { ...counters };
    const warm = await scanOnce(root);
    const warmCounters = { ...counters };
    for (const [kind, run, samples] of [["cold", cold, coldCounters], ["warm", warm, warmCounters]] as const) {
      results.push({
        shape: shape.name,
        kind,
        files: fixture.files,
        dirs: fixture.dirs,
        logicalBytes: run.scan.measured,
        phase: run.scan.phase,
        wallMs: Math.round(run.wallMs * 100) / 100,
        cpuMs: Math.round(run.cpuMs * 100) / 100,
        peakRssBytes: run.peakRss,
        filesPerSecond: Math.round((fixture.files / run.wallMs) * 1000),
        dirsPerSecond: Math.round((fixture.dirs / run.wallMs) * 1000),
        counters: samples,
      });
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

const cancelRoot = await fsp.mkdtemp(join(tmpdir(), "fix-storage-bench-cancel-"));
try {
  for (let dir = 0; dir < 6; dir++) {
    const folder = join(cancelRoot, `dir-${dir}`);
    await fsp.mkdir(folder);
    for (let index = 0; index < 200; index++) await fsp.writeFile(join(folder, `file-${index}.bin`), Buffer.alloc(4096, 7));
  }
  results.push({ shape: "cancellation-6x200", kind: "cancel", ...(await cancellationLatency(cancelRoot)) });
} finally {
  await fsp.rm(cancelRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ generatedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version, results }, null, 2));

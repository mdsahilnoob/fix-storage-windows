import { afterEach, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoDrives, demoLayout, demoSpace, startDemoScan } from "../src/core/demo";
import { IS_MAC, IS_WINDOWS } from "../src/core/platform";
import { diskSpace, emptySnapshot, startScan, type ScanSnapshot } from "../src/core/scan";
import { toJson, toText } from "../src/plain";
import { diskSegments } from "../src/ui/bar";

const drive = demoDrives()[0];
const stats = { blocks: 100, bsize: 1024, bfree: 95, bavail: 90, files: 100, ffree: 90, type: 0 };
const used = (IS_MAC || IS_WINDOWS ? 10 : 5) * stats.bsize;
const space = { total: 100 * stats.bsize, used, available: 90 * stats.bsize };
const statfs = spyOn(fs, "statfs");

afterEach(() => statfs.mockReset());

test("filesystem accounting keeps Linux reserved blocks outside used and reads the selected drive", async () => {
  statfs.mockResolvedValue(stats);
  const selected = { ...drive, mount: "/mnt/example" };
  expect(await diskSpace(selected)).toEqual(space);
  expect(statfs).toHaveBeenCalledWith(IS_MAC ? "/System/Volumes/Data" : selected.mount);
});

test("independent folder estimates can exceed filesystem usage during and after a scan", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "fix-storage-test-"));
  try {
    await fs.mkdir(join(root, "first"));
    await fs.mkdir(join(root, "second"));
    await fs.writeFile(join(root, "first", "example.bin"), Buffer.alloc(64 * 1024, 1));
    await fs.link(join(root, "first", "example.bin"), join(root, "second", "example.bin"));

    statfs.mockResolvedValue(stats);
    const layout = { ...demoLayout(drive), roots: [{ path: root, category: "documents" as const }] };
    const updates: ScanSnapshot[] = [];
    const scan = await startScan(layout, (update) => updates.push(update), { concurrency: 1, throttleMs: 0 }).done;

    expect(updates.some((update) => update.phase === "scanning" && update.measured > update.used)).toBe(true);
    for (const update of updates) expect(update).toMatchObject(space);
    expect(scan.measured).toBeGreaterThan(scan.total);
    expect(scan.sizes.documents).toBe(scan.measured);
    expect(scan.sizes.system).toBe(0);
    expect(scan.items.documents).toHaveLength(2);
    expect(JSON.parse(toJson(scan, layout))).toMatchObject({ ...space, measured: scan.measured });
    expect(toText(scan, layout, 1)).toContain("above filesystem usage");
    expect(diskSegments(scan).reduce((sum, s) => sum + s.fraction, 0)).toBeCloseTo(used / space.total);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the completed scan refreshes capacity, available bytes, and usage together", async () => {
  const after = { ...stats, blocks: 101, bfree: 94, bavail: 89 };
  statfs.mockResolvedValueOnce(stats).mockResolvedValueOnce(after);
  const scan = await startScan(demoLayout(drive), () => {}).done;
  expect(scan).toMatchObject({ total: 101 * stats.bsize, available: 89 * stats.bsize, used: used + 2 * stats.bsize });
});

test("a failed refresh keeps initial filesystem usage and accounts for unmeasured space", async () => {
  statfs.mockRejectedValue(new Error("unavailable")).mockResolvedValueOnce(stats);
  const scan = await startScan(demoLayout(drive), () => {}).done;
  expect(scan).toMatchObject({ ...space, measured: 0 });
  expect(scan.sizes.system).toBe(used);
});

test("the meter leaves unmeasured usage occupied while the scan is in progress", () => {
  const scan = { ...emptySnapshot(), total: 100, used: 50, available: 40, measured: 20 };
  scan.sizes.documents = 20;
  const segments = diskSegments(scan);
  expect(segments.find((segment) => segment.id === "documents")?.fraction).toBeCloseTo(0.2);
  expect(segments.at(-1)?.fraction).toBeCloseTo(0.3);
});

test("demo scan keeps its disk totals steady as measurements arrive", async () => {
  const layout = demoLayout(drive);
  const space = demoSpace(drive);
  const handle = startDemoScan(layout, (update) => {
    expect(update).toMatchObject(space);
  });
  const scan = await handle.done;
  expect(scan.measured).toBe(space.used);
}, 10_000);

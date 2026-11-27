import { afterEach, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoDrives, demoLayout, demoSpace, startDemoScan } from "../src/core/demo";
import { IS_MAC } from "../src/core/platform";
import { diskSpace, emptySnapshot, startScan, type ScanSnapshot } from "../src/core/scan";
import { toJson, toText } from "../src/plain";
import { diskSegments } from "../src/ui/bar";
import { Store } from "../src/ui/store";

const drive = demoDrives()[0];
const stats = { blocks: 100, bsize: 1024, bfree: 95, bavail: 90, files: 100, ffree: 90, type: 0 };
const used = (IS_MAC ? 10 : 5) * stats.bsize;
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

test("dry-run clearing previews changes and restores the measured scan", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "fix-storage-test-"));
  const path = join(root, "example.bin");
  const layout = { ...demoLayout(drive), roots: [{ path: root, category: "caches" as const }] };
  const store = new Store({ demo: false, dryRun: true });
  const scan = { ...emptySnapshot(), ...space, phase: "done" as const, measured: 16 * 1024 };
  scan.sizes.caches = scan.measured;
  scan.items.caches = [{ path, size: scan.measured }];
  Object.assign(store, { state: { ...store.get(), scan, layout } });
  await fs.writeFile(path, "synthetic fixture");
  const remove = spyOn(fs, "rm").mockRejectedValue(new Error("unexpected removal"));
  try {
    let previewed = false;
    const done = new Promise<void>((resolve) => {
      const unsubscribe = store.subscribe(() => {
        const state = store.get();
        if (state.action && state.scan.sizes.caches === 0) {
          previewed = true;
          expect(state.scan).toMatchObject({ ...space, measured: scan.measured });
        }
        if (state.action || !state.note) return;
        unsubscribe();
        resolve();
      });
    });
    store.press("caches");
    store.press("caches");
    await done;
    expect(remove).not.toHaveBeenCalled();
    expect(previewed).toBe(true);
    expect(store.get().scan).toBe(scan);
    expect(store.get().freed).toBe(0);
    expect(store.get().note).toContain("would be cleared");
    expect(await fs.readFile(path, "utf8")).toBe("synthetic fixture");
  } finally {
    store.stop();
    remove.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("dry-run item removal keeps the original item and filesystem usage", async () => {
  const root = "/synthetic/caches";
  const path = join(root, "example.bin");
  const layout = { ...demoLayout(drive), roots: [{ path: root, category: "caches" as const }] };
  const store = new Store({ demo: false, dryRun: true });
  const scan = { ...emptySnapshot(), ...space, phase: "done" as const, measured: 16 * 1024 };
  scan.sizes.caches = scan.measured;
  scan.items.caches = [{ path, size: scan.measured }];
  Object.assign(store, { state: { ...store.get(), selected: "caches", scan, layout } });
  const remove = spyOn(fs, "rm").mockRejectedValue(new Error("unexpected removal"));
  try {
    const done = new Promise<void>((resolve) => {
      const unsubscribe = store.subscribe(() => {
        if (store.get().removing || !store.get().note) return;
        unsubscribe();
        resolve();
      });
    });
    store.removeItem();
    store.removeItem();
    await done;
    expect(remove).not.toHaveBeenCalled();
    expect(store.get().scan).toBe(scan);
    expect(store.get().freed).toBe(0);
    expect(store.get().note).toContain("would delete example.bin");
  } finally {
    store.stop();
    remove.mockRestore();
  }
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

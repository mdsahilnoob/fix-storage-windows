import { afterEach, expect, spyOn, test } from "bun:test";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { demoDrives, demoLayout, startDemoScan } from "../src/core/demo";
import { startScan, unmeasuredBytes, type ScanHandle } from "../src/core/scan";
import { toJson, toText } from "../src/plain";

const root = join(import.meta.dir, "..", "src");
const drive = demoDrives()[0];
const stats = { blocks: 100_000, bsize: 1024, bfree: 90_000, bavail: 90_000, files: 1, ffree: 1, type: 0 };
const statfs = spyOn(fsp, "statfs");
let readdir: ReturnType<typeof spyOn> | null = null;

afterEach(() => {
  statfs.mockReset();
  readdir?.mockRestore();
  readdir = null;
});

function layout() {
  return { ...demoLayout(drive), roots: [{ path: root, category: "documents" as const }] };
}

test("cancelling before scanning starts reports cancelled with no measured bytes", async () => {
  statfs.mockResolvedValue(stats);
  const handle = startScan(layout(), () => {}, { concurrency: 1, throttleMs: 0 });
  handle.cancel();
  const scan = await handle.done;

  expect(scan.phase).toBe("cancelled");
  expect(scan.measured).toBe(0);
  expect(scan.sizes.system).toBe(0);
  expect(unmeasuredBytes(scan)).toBeGreaterThan(0);
});

test("demo cancellation resolves as cancelled instead of pretending the scan completed", async () => {
  const handle = startDemoScan(demoLayout(drive), () => {});
  handle.cancel();
  const scan = await handle.done;

  expect(scan.phase).toBe("cancelled");
  expect(scan.measured).toBe(0);
  expect(scan.sizes.system).toBe(0);
});

test("cancellation during root enumeration stops entry processing", async () => {
  statfs.mockResolvedValue(stats);
  const original = fsp.readdir.bind(fsp);
  let handle: ScanHandle;
  let cancelledOnce = false;
  readdir = spyOn(fsp, "readdir").mockImplementation((async (...args: unknown[]) => {
    const entries = await (original as (...items: unknown[]) => Promise<unknown>)(...args);
    if (!cancelledOnce) {
      cancelledOnce = true;
      handle.cancel();
    }
    return entries;
  }) as typeof fsp.readdir);

  handle = startScan(layout(), () => {}, { concurrency: 1, throttleMs: 0 });
  const scan = await handle.done;

  expect(scan.phase).toBe("cancelled");
  expect(scan.measured).toBe(0);
  expect(scan.sizes.system).toBe(0);
});

test("cancellation during nested measurement preserves partial results without System inflation", async () => {
  statfs.mockResolvedValue(stats);
  let handle: ScanHandle;
  let lastMeasured = 0;
  let cancelledAt = 0;
  handle = startScan(
    layout(),
    (snapshot) => {
      if (snapshot.phase === "scanning" && snapshot.measured > 0 && snapshot.current !== root && snapshot.measured !== lastMeasured) {
        cancelledAt = snapshot.measured;
        handle.cancel();
      }
      lastMeasured = snapshot.measured;
    },
    { concurrency: 4, throttleMs: 0 },
  );
  const scan = await handle.done;

  expect(scan.phase).toBe("cancelled");
  expect(cancelledAt).toBeGreaterThan(0);
  expect(scan.measured).toBe(cancelledAt);
  expect(scan.sizes.system).toBe(0);
  expect(unmeasuredBytes(scan)).toBeGreaterThan(0);
});

test("cancelling concurrent work does not add partial measurements after cancellation", async () => {
  statfs.mockResolvedValue(stats);
  let handle: ScanHandle;
  let cancelledAt = -1;
  handle = startScan(
    layout(),
    (snapshot) => {
      if (snapshot.phase === "scanning" && snapshot.measured > 0 && cancelledAt < 0) {
        cancelledAt = snapshot.measured;
        handle.cancel();
      }
    },
    { concurrency: 4, throttleMs: 0 },
  );
  const scan = await handle.done;

  expect(scan.phase).toBe("cancelled");
  expect(cancelledAt).toBeGreaterThan(0);
  expect(scan.measured).toBe(cancelledAt);
  expect(scan.sizes.system).toBe(0);
});

test("cancelling after all work completed keeps the completed state", async () => {
  statfs.mockResolvedValue(stats);
  const handle = startScan(layout(), () => {}, { concurrency: 2, throttleMs: 0 });
  const scan = await handle.done;
  const measured = scan.measured;
  const system = scan.sizes.system;

  handle.cancel();

  expect(scan.phase).toBe("completed");
  expect(scan.measured).toBe(measured);
  expect(scan.sizes.system).toBe(system);
});

test("cancelled JSON and text reports expose partial status and keep unmeasured bytes separate", async () => {
  statfs.mockResolvedValue(stats);
  const handle = startScan(layout(), () => {}, { concurrency: 1, throttleMs: 0 });
  handle.cancel();
  const scan = await handle.done;
  const report = JSON.parse(toJson(scan, layout()));

  expect(report.phase).toBe("cancelled");
  expect(report.partial).toBe(true);
  expect(report.unmeasured).toBeGreaterThan(0);
  expect(report.measured).toBe(0);
  expect(report.categories.find((category: { id: string }) => category.id === "system").bytes).toBe(0);
  expect(toText(scan, layout(), 1)).toContain("Analysis cancelled: partial results only.");
});

test("unexpected scan failures report failed rather than completed", async () => {
  statfs.mockResolvedValue(stats);
  let updates = 0;
  const handle = startScan(
    layout(),
    (snapshot) => {
      updates++;
      if (snapshot.phase === "scanning") throw new Error("synthetic scan failure");
    },
    { concurrency: 1, throttleMs: 0 },
  );
  const scan = await handle.done;

  expect(updates).toBeGreaterThan(0);
  expect(scan.phase).toBe("failed");
  expect(scan.error).toContain("synthetic scan failure");
  expect(scan.measured).toBe(0);
});

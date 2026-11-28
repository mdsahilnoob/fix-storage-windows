import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { listFolder } from "../src/core/browse";
import { classify } from "../src/core/classify";
import { demoDrives, demoLayout } from "../src/core/demo";
import { IS_WINDOWS } from "../src/core/platform";
import { duplicateCandidates } from "../src/core/recommendations";
import { startScan, unmeasuredBytes, type ScanSnapshot } from "../src/core/scan";
import { windowsReviewRestriction } from "../src/core/windows/permissions";
import { extendedPath, normalPath, windowsEntryKind } from "../src/core/windows/paths";
import { windowsDu, windowsFileSize } from "../src/core/windows/scan";
import type { Item } from "../src/core/scan";

const stats = { blocks: 200_000, bsize: 1024, bfree: 100_000, bavail: 100_000, files: 1, ffree: 1, type: 0 };
const used = (stats.blocks - stats.bavail) * stats.bsize;
const statfs = spyOn(fsp, "statfs");
let root = "";
let readdirSpy: ReturnType<typeof spyOn> | null = null;
let lstatSpy: ReturnType<typeof spyOn> | null = null;

beforeEach(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), "fix-storage-scanner-"));
  statfs.mockResolvedValue(stats);
});

afterEach(async () => {
  statfs.mockReset();
  readdirSpy?.mockRestore();
  lstatSpy?.mockRestore();
  readdirSpy = null;
  lstatSpy = null;
  if (root) {
    await fsp.rm(extendedPath(root), { recursive: true, force: true }).catch(() => undefined);
    root = "";
  }
});

async function makeFile(relative: string, bytes: number): Promise<string> {
  const path = join(root, relative);
  await fsp.mkdir(dirname(path), { recursive: true });
  await fsp.writeFile(path, Buffer.alloc(bytes, 7));
  return path;
}

async function makeDir(relative: string): Promise<string> {
  const path = join(root, relative);
  await fsp.mkdir(path, { recursive: true });
  return path;
}

function layout(roots: Array<{ path: string; category: "documents" | "apps" | "developer" }>, skip: (path: string) => boolean = () => false) {
  const drive = { ...demoDrives()[0], mount: root, capacity: stats.blocks * stats.bsize, freeSpace: stats.bavail * stats.bsize };
  return { ...demoLayout(drive), roots, skip };
}

async function scan(
  roots: Array<{ path: string; category: "documents" | "apps" | "developer" }>,
  skip: (path: string) => boolean = () => false,
): Promise<ScanSnapshot> {
  return startScan(layout(roots, skip), () => {}, { concurrency: 2, throttleMs: 0 }).done;
}

function listOnce(path: string, foreign: (path: string) => boolean = () => false): Promise<Item[]> {
  return new Promise((resolve) => {
    listFolder(path, (items, done) => {
      if (done) resolve(items);
    }, foreign);
  });
}

test("traverses files and nested directories with exact logical sizes", async () => {
  const a = await makeFile("a.bin", 1000);
  const b = await makeFile("sub/b.bin", 2048);
  const c = await makeFile("sub/nested/c.bin", 300);
  await makeFile("empty.bin", 0);

  const result = await scan([{ path: root, category: "documents" }]);

  expect(result.phase).toBe("completed");
  expect(result.measured).toBe(3348);
  expect(result.sizes.documents).toBe(3348);
  expect(result.sizes.system).toBe(used - 3348);
  expect(unmeasuredBytes(result)).toBe(used - 3348);
  expect(result.items.documents).toHaveLength(2);
  expect(result.items.documents.map((item) => [basename(item.path), item.size, item.dir, item.kind])).toEqual([
    ["sub", 2348, true, "directory"],
    ["a.bin", 1000, false, "file"],
  ]);
  expect(await windowsDu(join(root, "sub"))).toEqual({ bytes: 2348, denied: false });
  expect(await windowsFileSize(a)).toBe(1000);
  expect(await windowsFileSize(b)).toBe(2048);
  expect(await windowsFileSize(c)).toBe(300);
});

test("keeps nested roots separate instead of double counting them", async () => {
  const a = await makeFile("parent/a.bin", 1000);
  const b = await makeFile("parent/child/b.bin", 2000);
  const child = join(root, "parent", "child");

  const result = await scan([
    { path: join(root, "parent"), category: "documents" },
    { path: child, category: "apps" },
  ]);

  expect(result.measured).toBe(3000);
  expect(result.sizes.documents).toBe(1000);
  expect(result.sizes.apps).toBe(2000);
  expect(result.items.documents.map((item) => item.path)).toEqual([a]);
  expect(result.items.apps.map((item) => item.path)).toEqual([b]);
});

test("honors skip/foreign boundaries and reports protected paths", async () => {
  await makeFile("local.bin", 100);
  await makeFile("foreign/blocked.bin", 500);
  await makeFile("local-dir/kept.bin", 200);

  const result = await scan([{ path: root, category: "documents" }], (path) => basename(path) === "foreign");
  expect(result.measured).toBe(300);
  expect(result.items.documents.some((item) => basename(item.path) === "foreign")).toBe(false);

  const browsed = await listOnce(root, (path) => basename(path) === "foreign");
  expect(browsed.some((item) => basename(item.path) === "foreign")).toBe(false);
  expect(browsed.some((item) => basename(item.path) === "local-dir")).toBe(true);

  const protectedLayout = layout([{ path: root, category: "documents" }]);
  expect(windowsReviewRestriction(join(root, "Windows", "system.bin"), protectedLayout)).not.toBeNull();
  expect(windowsReviewRestriction(join(root, "local-dir", "kept.bin"), protectedLayout)).toBeNull();
  expect(classify({ path: join(root, "Windows", "system.bin"), size: 1 }, "system").verdict).toBe("system");
  expect(classify({ path: join(root, "$Recycle.Bin", "old.bin"), size: 1 }, "trash").verdict).toBe("junk");
});

test("reports file-level permission errors as blocked", async () => {
  await makeFile("visible.bin", 100);
  const secret = await makeFile("secret.bin", 200);

  const original = fsp.lstat.bind(fsp);
  lstatSpy = spyOn(fsp, "lstat").mockImplementation((async (...args: unknown[]) => {
    if (normalPath(String(args[0])).endsWith("\\secret.bin")) {
      const error = new Error("access denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    }
    return (original as (...items: unknown[]) => Promise<unknown>)(...args);
  }) as typeof fsp.lstat);

  const result = await scan([{ path: root, category: "documents" }]);
  expect(result.measured).toBe(100);
  expect(result.blocked).toContain(secret);
});

test("does not suppress a denied nested subtree when accessible bytes exceed 1 MiB", async () => {
  const huge = await makeDir("huge");
  await makeFile("huge/readable.bin", 1_500_000);
  const denied = await makeDir("huge/denied");
  await makeFile("huge/denied/secret.bin", 100);

  const original = fsp.readdir.bind(fsp);
  readdirSpy = spyOn(fsp, "readdir").mockImplementation((async (...args: unknown[]) => {
    if (normalPath(String(args[0])).endsWith("\\huge\\denied")) {
      const error = new Error("access denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    }
    return (original as (...items: unknown[]) => Promise<unknown>)(...args);
  }) as typeof fsp.readdir);

  const result = await scan([{ path: root, category: "documents" }]);
  expect(result.measured).toBe(1_500_000);
  expect(result.blocked).toContain(huge);
  expect(denied).toContain("denied");
});

test("enforces layout.foreign boundaries during scanning", async () => {
  await makeFile("local.bin", 100);
  await makeFile("foreign/blocked.bin", 500);
  const custom = layout([{ path: root, category: "documents" }]);
  custom.foreign = (path) => basename(path) === "foreign";

  const result = await startScan(custom, () => {}, { concurrency: 1, throttleMs: 0 }).done;
  expect(result.measured).toBe(100);
  expect(result.items.documents.some((item) => basename(item.path) === "foreign")).toBe(false);
});

test("reports directory permission errors as blocked instead of discarding them", async () => {
  await makeFile("visible.bin", 100);
  const denied = await makeDir("denied");
  await makeFile("denied/secret.bin", 500);

  const original = fsp.readdir.bind(fsp);
  readdirSpy = spyOn(fsp, "readdir").mockImplementation((async (...args: unknown[]) => {
    const path = String(args[0]);
    if (normalPath(path).endsWith("\\denied")) {
      const error = new Error("access denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    }
    return (original as (...items: unknown[]) => Promise<unknown>)(...args);
  }) as typeof fsp.readdir);

  const result = await scan([{ path: root, category: "documents" }]);
  expect(result.phase).toBe("completed");
  expect(result.measured).toBe(100);
  expect(result.blocked).toContain(denied);
  expect(await windowsDu(denied)).toEqual({ bytes: 0, denied: true });
});

test("does not traverse junctions or reparse directories", async () => {
  if (!IS_WINDOWS) return;
  const target = await makeDir("target");
  await makeFile("target/inside.bin", 4096);
  const link = join(root, "junction");
  await fsp.symlink(target, link, "junction");
  const linkSize = (await fsp.lstat(link)).size;

  const result = await scan([{ path: root, category: "documents" }]);
  expect(await windowsEntryKind(link)).toBe("link");
  expect(await windowsDu(link)).toEqual({ bytes: linkSize, denied: false });
  expect(result.measured).toBe(4096 + linkSize);
  expect(result.items.documents.map((item) => basename(item.path)).sort()).toEqual(["junction", "target"]);
  const junctionItem = result.items.documents.find((item) => basename(item.path) === "junction");
  expect(junctionItem?.dir).toBe(false);
  expect(junctionItem?.kind).toBe("reparse");
});

test("handles Unicode names and very long Windows paths", async () => {
  const unicode = "unicodé-文件-😀";
  const unicodeFile = await makeFile(`${unicode}/résumé-数据.txt`, 777);
  const unicodeScan = await scan([{ path: root, category: "documents" }]);
  expect(unicodeScan.measured).toBe(777);
  expect(unicodeScan.items.documents[0]?.path).toBe(join(root, unicode));
  expect(unicodeScan.items.documents[0]?.size).toBe(777);
  expect((await listOnce(root)).some((item) => item.path === join(root, unicode))).toBe(true);
  expect(unicodeFile).toContain(unicode);

  if (!IS_WINDOWS) return;
  let deep = root;
  for (let index = 0; index < 8; index++) deep = join(deep, `segment-${index}-${"x".repeat(32)}`);
  await fsp.mkdir(extendedPath(deep), { recursive: true });
  const longFile = join(deep, "long.bin");
  await fsp.writeFile(extendedPath(longFile), Buffer.alloc(1234));
  expect((await windowsDu(deep)).bytes).toBe(1234);
  const longList = await listOnce(deep);
  expect(longList.map((item) => item.path)).toContain(longFile);
  const longScan = await scan([{ path: deep, category: "documents" }]);
  expect(longScan.measured).toBe(1234);
});

test("feeds same-name same-size scanner items to duplicate-candidate grouping", async () => {
  const left = await makeDir("left");
  const right = await makeDir("right");
  await makeFile("left/dupe.bin", 1_200_000);
  await makeFile("right/dupe.bin", 1_200_000);
  const [leftItems, rightItems] = await Promise.all([listOnce(left), listOnce(right)]);
  const groups = duplicateCandidates([...leftItems, ...rightItems]);

  expect(groups).toHaveLength(1);
  expect(groups[0].count).toBe(2);
  expect(groups[0].size).toBe(1_200_000);
  expect(groups[0].paths).toHaveLength(2);
  expect(groups[0].warning).toContain("Contents have not been compared.");
});

test("aggregates large directories and preserves logical file sizes", async () => {
  for (let index = 0; index < 200; index++) await makeFile(`many/file-${String(index).padStart(3, "0")}.bin`, 100);
  await makeFile("logical/large.bin", 1024 * 1024);

  const result = await scan([{ path: root, category: "documents" }]);
  expect(result.measured).toBe(200 * 100 + 1024 * 1024);
  expect(result.items.documents).toHaveLength(2);
  expect(result.items.documents.find((item) => basename(item.path) === "many")?.size).toBe(20_000);
  expect(result.items.documents.find((item) => basename(item.path) === "logical")?.size).toBe(1024 * 1024);
});

test("cancelled scans preserve partial bytes and never add unmeasured bytes to System", async () => {
  for (let index = 0; index < 100; index++) await makeFile(`bulk/file-${index}.bin`, 200);
  let cancelledAt = -1;
  let handle!: ReturnType<typeof startScan>;
  handle = startScan(layout([{ path: root, category: "documents" }]), (snapshot) => {
    if (snapshot.phase === "scanning" && snapshot.measured > 0 && cancelledAt < 0) {
      cancelledAt = snapshot.measured;
      handle.cancel();
    }
  }, { concurrency: 4, throttleMs: 0 });

  const result = await handle.done;
  expect(result.phase).toBe("cancelled");
  expect(cancelledAt).toBeGreaterThan(0);
  expect(result.measured).toBe(cancelledAt);
  expect(result.sizes.system).toBe(0);
  expect(unmeasuredBytes(result)).toBeGreaterThan(0);
});

test("failed scans remain failed with no System inflation", async () => {
  await makeFile("file.bin", 100);
  let handle!: ReturnType<typeof startScan>;
  let updates = 0;
  handle = startScan(layout([{ path: root, category: "documents" }]), (snapshot) => {
    updates++;
    if (snapshot.phase === "scanning") throw new Error("synthetic failure");
  }, { concurrency: 1, throttleMs: 0 });

  const result = await handle.done;
  expect(updates).toBeGreaterThan(0);
  expect(result.phase).toBe("failed");
  expect(result.error).toContain("synthetic failure");
  expect(result.sizes.system).toBe(0);
});

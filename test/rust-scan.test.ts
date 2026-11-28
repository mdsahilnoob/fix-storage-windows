import { afterEach, expect, test } from "bun:test";
import { existsSync, promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoDrives, demoLayout } from "../src/core/demo";
import { IS_WINDOWS } from "../src/core/platform";
import { startRustScan } from "../src/core/rust-scan";

const executable = join(import.meta.dir, "..", "scanner-rust", "target", "release", "fix-storage-scanner-rust.exe");
const available = IS_WINDOWS && existsSync(executable);
const rustTest = available ? test : test.skip;
let root = "";

afterEach(async () => {
  if (root) await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
  root = "";
});

rustTest("converts a Rust scan into a complete ScanSnapshot", async () => {
  root = await fsp.mkdtemp(join(tmpdir(), "fix-storage-rust-scan-"));
  await fsp.mkdir(join(root, "sub"));
  await fsp.writeFile(join(root, "a.bin"), Buffer.alloc(1000, 7));
  await fsp.writeFile(join(root, "sub", "b.bin"), Buffer.alloc(2000, 7));
  const drive = { ...demoDrives()[0], mount: root, capacity: 1_000_000_000, freeSpace: 900_000_000 };
  const layout = { ...demoLayout(drive), roots: [{ path: root, category: "documents" as const }] };
  const updates: number[] = [];
  const handle = startRustScan(layout, (snapshot) => updates.push(snapshot.measured), { executable, batchSize: 10, threads: 2 });
  const scan = await handle.done;

  expect(scan.phase).toBe("completed");
  expect(scan.measured).toBe(3000);
  expect(scan.sizes.documents).toBe(3000);
  expect(scan.items.documents).toHaveLength(2);
  expect(updates.some((measured) => measured > 0)).toBe(true);
});

rustTest("propagates Rust cancellation into the ScanSnapshot phase", async () => {
  root = await fsp.mkdtemp(join(tmpdir(), "fix-storage-rust-cancel-"));
  await fsp.writeFile(join(root, "a.bin"), Buffer.alloc(100, 7));
  const drive = { ...demoDrives()[0], mount: root, capacity: 1_000_000_000, freeSpace: 900_000_000 };
  const layout = { ...demoLayout(drive), roots: [{ path: root, category: "documents" as const }] };
  const handle = startRustScan(layout, () => {}, { executable, batchSize: 1 });
  handle.cancel();
  const scan = await handle.done;
  expect(scan.phase).toBe("cancelled");
});

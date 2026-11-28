import { resolve } from "node:path";
import { CATEGORIES } from "../src/core/categories";
import { demoDrives, demoLayout } from "../src/core/demo";
import { startScan, unmeasuredBytes } from "../src/core/scan";
import { normalPath, windowsEntryKind } from "../src/core/windows/paths";

const root = process.argv[2];
if (!root) {
  console.error("Usage: bun tools/scanner-reference.ts <corpus-root>");
  process.exit(2);
}

const absolute = resolve(root);
const drive = { ...demoDrives()[0], mount: absolute, capacity: 0, freeSpace: 0 };
const layout = {
  ...demoLayout(drive),
  roots: [{ path: absolute, category: "documents" as const }],
};
const scan = await startScan(layout, () => {}, { concurrency: 6, throttleMs: 0 }).done;

const entries = CATEGORIES.flatMap((category) =>
  scan.items[category.id].map((item) => ({
    displayPath: item.path,
    pathKey: normalPath(item.path),
    type: item.dir ? "directory" : "file",
    logicalBytes: item.size,
    category: category.id,
  })),
).sort((left, right) => left.pathKey.localeCompare(right.pathKey));

const errors = (await Promise.all(
  scan.blocked.map(async (path) => ({
    displayPath: path,
    pathKey: normalPath(path),
    kind: (await windowsEntryKind(path)) === "link" ? ("reparse" as const) : ("unreadable" as const),
  })),
)).sort((left, right) => left.pathKey.localeCompare(right.pathKey));

const report = {
  schemaVersion: "1.0",
  implementation: { name: "typescript-reference", version: "0.1.0" },
  scan: {
    phase: scan.phase,
    partial: scan.phase !== "completed",
    error: scan.error ?? null,
  },
  volume: {
    id: drive.id,
    mount: drive.mount,
    totalBytes: scan.total,
    usedBytes: scan.used,
    availableBytes: scan.available,
  },
  totals: {
    measuredBytes: scan.measured,
    unmeasuredBytes: unmeasuredBytes(scan),
    categoryBytes: scan.sizes,
    fileEntries: entries.filter((entry) => entry.type === "file").length,
    directoryEntries: entries.filter((entry) => entry.type === "directory").length,
    errorCount: errors.length,
  },
  entries,
  errors,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

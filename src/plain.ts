import { CATEGORIES, TIER_LABEL } from "./core/categories";
import { demoDrives, demoLayout, demoSpace, startDemoScan } from "./core/demo";
import { describePartition, listDrives, mountCommand, pickDrive, type Drive, type Partition } from "./core/drives";
import { capacity, gb, size, tilde } from "./core/format";
import { layoutFor, type Layout } from "./core/layout";
import { IS_MAC, IS_WINDOWS } from "./core/platform";
import { rustScannerExecutable, rustScannerPathArg, scannerArg, selectScannerEngine } from "./core/scanner-selection";
import { startRustScan } from "./core/rust-scan";
import { diskSpace, startScan, unmeasuredBytes, type ScanHandle, type ScanSnapshot } from "./core/scan";

/** The value given with --drive, as `--drive x` or `--drive=x`. */
export function driveArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--drive") return args[i + 1];
    if (args[i].startsWith("--drive=")) return args[i].slice("--drive=".length);
  }
  return undefined;
}

/** Text and JSON output, for terminals without graphics and for scripts. Never deletes anything. */
export async function runPlain(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const demo = args.includes("--demo");
  const { drives, unmounted } = demo ? { drives: demoDrives(), unmounted: [] as Partition[] } : await listDrives();

  if (args.includes("--drives")) {
    const spaces = await Promise.all(drives.map((d) => (demo ? demoSpace(d) : diskSpace(d))));
    process.stdout.write(json ? drivesJson(drives, spaces, unmounted) : drivesText(drives, spaces, unmounted));
    return;
  }

  const wanted = driveArg(args);
  const drive = pickDrive(wanted, drives);
  if (!drive) throw new Error(`no drive matches ${wanted}; fix-storage --drives lists them`);
  const layout = demo ? demoLayout(drive) : await layoutFor(drive);
  const engine = selectScannerEngine(scannerArg(args));
  if (engine === "rust" && demo) throw new Error("the Rust scanner cannot be used with --demo");
  const start: (target: Layout, update: (snapshot: ScanSnapshot) => void) => ScanHandle =
    demo
      ? startDemoScan
      : engine === "rust"
        ? (target, update) => {
            const executable = rustScannerPathArg(args) ?? rustScannerExecutable();
            if (!executable) throw new Error("the Rust scanner requires --scanner-rust-path or FIX_STORAGE_RUST_SCANNER");
            return startRustScan(target, update, { executable });
          }
        : startScan;
  const live = process.stderr.isTTY === true;

  const handle = start(layout, (snapshot) => {
    if (!live || snapshot.phase !== "scanning") return;
    const columns = process.stderr.columns ?? 80;
    const line = `${gb(snapshot.measured)} measured  ${tilde(snapshot.current)}`;
    process.stderr.write(`\r\x1b[2K${line.slice(0, columns - 1)}`);
  });
  process.on("SIGINT", () => {
    handle.cancel();
    if (live) process.stderr.write("\r\x1b[2K");
    process.exit(130);
  });

  const scan = await handle.done;
  if (live) process.stderr.write("\r\x1b[2K");
  process.stdout.write(json ? toJson(scan, layout) : toText(scan, layout, drives.length));
}

function driveInfo(drive: Drive) {
  return {
    name: drive.name,
    mount: drive.mount,
    mounts: drive.mounts.map((m) => m.point),
    device: drive.device,
    fstype: drive.fstype,
    label: drive.label,
    kind: drive.kind,
    readOnly: drive.readOnly,
    driveType: drive.driveType,
  };
}

function drivesJson(drives: Drive[], spaces: Array<{ total: number; used: number; available: number } | null>, unmounted: Partition[]): string {
  return (
    JSON.stringify(
      {
        drives: drives.map((d, i) => ({ ...driveInfo(d), ...(spaces[i] ?? {}) })),
        unmounted: unmounted.map((p) => ({ ...p, mount: mountCommand(p) })),
      },
      null,
      2,
    ) + "\n"
  );
}

function drivesText(drives: Drive[], spaces: Array<{ total: number; used: number; available: number } | null>, unmounted: Partition[]): string {
  const lines: string[] = [];
  if (drives.length === 0) lines.push("No accessible mounted volumes.");
  const width = Math.max(0, ...drives.map((d) => d.name.length));
  drives.forEach((drive, i) => {
    const space = spaces[i];
    const usage = space && space.total > 0 ? `${gb(space.used).padStart(9)} of ${capacity(space.total).padEnd(8)}` : "".padEnd(21);
    const where = drive.name === drive.mount ? "" : `  ${drive.mount}`;
    const kind = drive.kind === "main" || drive.kind === "data" ? "" : `  ${drive.kind}, look only`;
    const ro = drive.readOnly ? "  read-only" : "";
    const driveType = IS_WINDOWS && drive.driveType ? `  ${drive.driveType}` : "";
    lines.push(`${String(i + 1).padStart(2)}  ${drive.name.padEnd(width)}  ${usage}  ${drive.fstype.padEnd(6)}${where}${driveType}${kind}${ro}`);
  });
  if (unmounted.length > 0) {
    lines.push("", "Not mounted (mount one read-only to look inside):");
    const described = unmounted.map(describePartition);
    const wide = Math.max(...described.map((d) => d.length));
    unmounted.forEach((p, i) => {
      lines.push(`    ${described[i].padEnd(wide)}  ${capacity(p.size).padStart(8)}    ${mountCommand(p)}`);
    });
  }
  if (!IS_MAC && drives.length > 1) lines.push("", "Scan one with fix-storage --drive <number, name or path>.");
  return lines.join("\n") + "\n";
}

export function toJson(scan: ScanSnapshot, layout: Layout): string {
  return (
    JSON.stringify(
      {
        drive: { ...driveInfo(layout.drive), lookOnly: layout.lookOnly },
        phase: scan.phase,
        partial: scan.phase !== "completed",
        unmeasured: unmeasuredBytes(scan),
        total: scan.total,
        used: scan.used,
        available: scan.available,
        measured: scan.measured,
        categories: CATEGORIES.map((c) => ({
          id: c.id,
          name: c.name,
          tier: c.tier,
          bytes: scan.sizes[c.id],
          largest: scan.items[c.id].slice(0, 5),
        })),
        blocked: scan.blocked,
        mode: "read-only-analysis-and-recommendations",
        cleanup: { automatedCleanupSupported: false, estimatesOnly: true, categoryEstimatesMayOverlap: true },
      },
      null,
      2,
    ) + "\n"
  );
}

export function toText(scan: ScanSnapshot, layout: Layout, driveCount: number): string {
  const lines: string[] = [];
  const { drive } = layout;
  if (!IS_MAC) {
    const where = drive.name === drive.mount ? "" : ` at ${drive.mount}`;
    lines.push(`${drive.name}${where} (${drive.fstype}${drive.device ? `, ${drive.device}` : ""})`);
  }
  lines.push(`${gb(scan.used)} of ${capacity(scan.total)} used, ${gb(scan.available)} available`);
  if (scan.total > 0 && scan.measured > scan.used) {
    lines.push(`${gb(scan.measured)} measured across files and folders (${size(scan.measured - scan.used)} above filesystem usage)`);
  }
  if (scan.phase === "cancelled") {
    lines.push(`Analysis cancelled: partial results only. ${gb(scan.measured)} measured; ${gb(unmeasuredBytes(scan))} unmeasured.`);
  } else if (scan.phase === "failed") {
    lines.push(`Analysis failed${scan.error ? `: ${scan.error}` : ""}. Partial results only.`);
  } else if (scan.phase === "scanning") {
    lines.push("Analysis in progress; results are partial.");
  }
  if (layout.lookOnly) lines.push(layout.lookOnly.charAt(0).toUpperCase() + layout.lookOnly.slice(1));
  lines.push("");

  const width = Math.max(...CATEGORIES.map((c) => c.name.length));
  for (const category of CATEGORIES) {
    const amount = gb(scan.sizes[category.id]).padStart(9);
    lines.push(`${category.name.padEnd(width)}  ${amount}  ${TIER_LABEL[category.tier]}`);
  }

  for (const category of CATEGORIES) {
    if (category.tier !== "safe" || scan.items[category.id].length === 0) continue;
    lines.push("", `${category.name}: ${category.blurb}`);
    for (const item of scan.items[category.id].slice(0, 5)) {
      lines.push(`  ${size(item.size).padStart(8)}  ${tilde(item.path)}`);
    }
  }

  if (scan.blocked.length > 0) {
    const accounted = scan.phase === "completed" ? "and count as System data" : "and remain unmeasured";
    lines.push(
      "",
      IS_MAC
        ? `Could not read (give your terminal Full Disk Access to include these; they are left untouched ${accounted}):`
        : IS_WINDOWS
          ? `Could not read (access denied, locked, or unavailable paths are left untouched ${accounted}):`
          : `Could not read (they belong to root or another user, and are left untouched ${accounted}):`,
    );
    for (const path of scan.blocked.slice(0, 8)) lines.push(`  ${tilde(path)}`);
    if (scan.blocked.length > 8) lines.push(`  and ${scan.blocked.length - 8} more`);
  }
  lines.push("", "READ-ONLY MODE — NO FILES WILL BE MODIFIED. Category sizes are estimates, may overlap, and must not be added as unique storage. Cleanup opportunities are informational only.");
  if (!IS_MAC && driveCount > 1) lines.push("", `${driveCount} drives mounted · fix-storage --drives lists them`);
  return lines.join("\n") + "\n";
}

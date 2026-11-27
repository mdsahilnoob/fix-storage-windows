#!/usr/bin/env node
"use strict";

const path = require("node:path");

const args = process.argv.slice(2);
const appDir = path.resolve(__dirname, "..");

const linux = process.platform === "linux";
const windows = process.platform === "win32";

const HELP = `fix-storage v1: READ-ONLY storage analysis and cleanup recommendations.

No files are deleted, recycled, moved, renamed or modified.

Usage: fix-storage [options]

  (no options)   Open the interactive analysis view. ${windows ? "Uses a character-based React UI\n                 in Windows Terminal, PowerShell, or Windows Console." : `Needs a terminal with kitty
                  graphics (Ghostty, kitty, iTerm2, WezTerm); other terminals
                  get a simpler character view.`}
  --demo         Use a made-up disk; reads and changes nothing.
  --plain        Print a text storage report and exit.
  --json         Print the storage report as JSON and exit.
${linux || windows ? `  --drives       List mounted drives${windows ? " and volumes without access paths" : ", and partitions that are not mounted"}, and exit.
  --drive <d>    Start on drive <d>: its number from --drives, its name, mount
                  point, label or device, or any path on it.
` : ""}  -h, --help     Show this help.

Automated cleanup is not supported in v1. Recommendations are informational
only; you decide whether to act on them outside this application.
`;

if (args.includes("-h") || args.includes("--help")) {
  process.stdout.write(HELP);
  process.exit(0);
}

const cleanupOptions = new Set([
  "--clean", "--cleanup", "--delete", "--remove", "--recycle", "--trash",
  "--apply", "--execute", "--empty-trash", "--empty-recycle-bin", "--purge", "--dry-run",
]);
for (const arg of args) {
  if (cleanupOptions.has(arg) || cleanupOptions.has(arg.split("=")[0])) {
    process.stderr.write(
      `fix-storage: automated cleanup is not supported in v1.\n` +
      `The application is READ-ONLY and never deletes, recycles, moves or modifies files.\n` +
      `View storage analysis and recommendations with --plain, --json or the interactive view.\n\n${HELP}`,
    );
    process.exit(2);
  }
}

const known = new Set(["--demo", "--plain", "--json", "--drives"]);
let unknown;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--drive") {
    if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
      process.stderr.write(`fix-storage: --drive needs a drive\n\n${HELP}`);
      process.exit(2);
    }
    i++;
  } else if (!known.has(arg) && !arg.startsWith("--drive=")) {
    unknown = arg;
    break;
  }
}
if (unknown) {
  process.stderr.write(`fix-storage: unknown option ${unknown}\n\n${HELP}`);
  process.exit(2);
}

if (windows && process.arch !== "x64") {
  process.stderr.write(`fix-storage: this Windows port supports x64, not ${process.arch}\n`);
  process.exit(1);
}

if (args.includes("--plain") || args.includes("--json") || args.includes("--drives") || !process.stdout.isTTY) {
  require(path.join(appDir, "dist", "plain.js"))
    .runPlain(args)
    .catch((error) => {
      process.stderr.write(`fix-storage: ${error && error.message ? error.message : error}\n`);
      process.exit(1);
    });
} else if (windows) {
  require(path.join(appDir, "dist", "main-windows.js"));
} else {
  process.stderr.write("fix-storage: this port supports Windows 10/11 x64; use the original project on macOS or Linux\n");
  process.exit(1);
}

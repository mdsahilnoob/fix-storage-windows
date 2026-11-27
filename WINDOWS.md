# Windows guide

## Support statement

This port targets Windows 10 and Windows 11 on x64 with Node.js 20.11+. The implementation is **untested and unverified** at this stage. No claim is made that every drive type, terminal, cache location, permission case, or Recycle Bin operation works on a particular machine yet. **Do not use the cleanup feature on real files until the validation matrix below has been completed.**

Implemented statically:

- CIM-based drive/volume discovery, including drive letters, NTFS folder mount points, volume GUIDs, removable drives, and unassigned volumes
- Capacity, used/free space, filesystem, label, drive type, and multi-drive selection
- Asynchronous recursive scanning, large-item browsing, culprit discovery, progress, cancellation, and bounded I/O
- Unicode and extended-length path handling for Node filesystem operations
- Reparse-point avoidance and per-item handling of inaccessible or disappearing paths
- Windows user/application/developer/game layouts and classifications
- Modification-time metadata (not last-opened claims)
- Text and JSON reports
- Ink/React interactive terminal navigation
- Explorer open/reveal integration
- Exact-path, two-step cleanup confirmation and dry-run
- Windows Recycle Bin-only file and directory cleanup with per-item results

Planned or not yet implemented:

- Allocated-on-disk cluster accounting and alternate-data-stream accounting
- Automatic discovery of every third-party application cache
- Known Folder redirection through Windows Known Folder APIs (standard profile folder names and AppData environment variables are currently used)
- Pixel graphics, mouse input, and Home/End keys in the Windows renderer
- Verified handling of every network, ReFS, exFAT, FAT32, BitLocker, VHD, and cloud-placeholder configuration
- Windows-specific automated tests and CI test coverage
- Cleanup from Windows services or headless hosts where the Windows Shell has no interactive user Recycle Bin context
- A hard guarantee against a Shell bug that permanently deletes an item despite forced recycle flags: `PostDeleteItem` can detect a missing Recycle Bin destination but cannot restore an already completed deletion
- Cleanup on network, optical, RAM, unknown, disabled-bin, or otherwise uncertain volume types; these cases are rejected before deletion

## Installation and setup

Use a non-elevated PowerShell window:

```powershell
node --version
npm --version
Set-Location C:\path\to\fix-storage-windows
npm install
npm run build
```

Run directly:

```powershell
node bin/fix-storage.cjs --demo
node bin/fix-storage.cjs --dry-run
```

Or install a user-level npm command:

```powershell
npm install --global .
fix-storage --help
```

The original Pixel-specific entry files are excluded from Windows builds because Pixel 0.3.1 has no Windows runtime. Ink provides the Windows UI. Recycling uses a fixed PowerShell/C# bridge over Windows `IFileOperation`. It forces recycle-on-delete, aborts pre-delete unless recycling is allowed, and requires `PostDeleteItem` to return a non-null Recycle Bin item before reporting success. Paths arrive as JSON on standard input, never as PowerShell/CMD source.

## Drive discovery

One non-interactive PowerShell query uses `Win32_Volume` and `Win32_MountPoint`. Volumes are grouped by their device/volume GUID. A volume can have a drive letter, one or more folder mount points, or no usable access path. Unassigned volumes are listed with Disk Management advice; the app does not mount them automatically.

Filesystem space comes from Node's `statfs` where available, with CIM capacity/free-space values as a fallback. A disconnected or unreadable volume produces zero/unavailable space or an error rather than a Unix command fallback.

## Scanning behavior

The scanner uses `lstat`/`readdir` asynchronously. Directory entries are handled in batches with a shared I/O limit. Symbolic links and junctions are not followed into other directories or volumes. This prevents link-induced traversal loops; hard links in separately measured roots can still make category estimates exceed actual filesystem usage.

Files can disappear or become locked while scanning. Such entries are skipped; denied roots appear in `blocked` and remaining unmeasured usage is represented as System data. File sizes are logical byte lengths, not compressed/sparse allocated sizes. Cloud placeholders are not opened for content, but metadata behavior still needs testing with each provider.

Cancellation stops scheduling further work. A large directory can still require an in-flight filesystem operation to finish before cancellation is observed. Culprit discovery retains only dominant branches and the three largest direct children per visited folder rather than constructing a permanent full-drive tree.

## Cleanup and dry-run

1. Select one item, or press `c` for eligible caches.
2. The app prepares the direct-child cache plan. The Recycle Bin itself is never a bulk-clear target.
3. Review every exact selected path, the item count, and estimated bytes.
4. Confirm again within 15 seconds. Navigation or timeout cancels the armed selection.
5. Before any delete is queued, `GetVolumePathNameW` must resolve the actual mount point (no drive-letter fallback), `GetVolumeNameForVolumeMountPointW` must yield the brace-delimited volume GUID, unsupported volume types are rejected, `SHQueryRecycleBin` must confirm a bin, per-volume `NukeOnDelete`, global `NoRecycleFiles`, and legacy BitBucket settings must be verified or absent by default, and both the Shell path and NTFS volume-serial/file-index identity must match the confirmed target. A reparse-point attribute from the native file handle stops cleanup.
6. `IFileOperation` uses `FOFX_RECYCLEONDELETE` and `FOFX_ADDUNDORECORD`. `PreDeleteItem` requires `TSF_DELETE_RECYCLE_IF_POSSIBLE`; `PostDeleteItem` requires one successful callback with recycle flags and a non-null Recycle Bin item; `FinishOperations` must also succeed with no aborted operations.
7. Successful and unsuccessful paths are recorded. `PostDeleteItem` is confirmation, not rollback: if it fails, the source may already have been permanently deleted, and the user is told to inspect manually. Source disappearance alone never counts as success. No result is retried with another mechanism.

Moving an item to the Recycle Bin does **not** reclaim its space. Windows still accounts for it until the user independently empties or restores items through Windows. This app has no empty-Recycle-Bin operation.

Accounting is reported in two separate fields: `movedToRecycleBinBytes` is the estimated logical size of items moved, while `freed` is derived only from a fresh filesystem measurement after cleanup and is normally zero until Windows empties the bin. The UI shows both session values; `removed` counts successfully recycled items rather than permanent deletions.

`--dry-run` scans real storage but never invokes recycling. `--demo` uses synthetic paths and data and does not scan real storage. Read-only reports never clean anything.

## Protected and ambiguous paths

Volume roots, Windows and system-managed trees, Program Files, Program Files (x86), ProgramData, boot/recovery locations, System Volume Information, `$Recycle.Bin`, user profile roots, measured roots, and standard personal-folder roots are protected. Explicitly selected eligible descendants of personal folders can only be recycled; they are never permanently deleted.

Junctions and symbolic links are rejected immediately before recycling. Docker data, package-manager stores, persistent AppData, game installations, saves, and user-created content are distinguished from rebuildable caches. No elevation is attempted.

See [docs/windows-security.md](docs/windows-security.md) and [docs/windows-storage-categories.md](docs/windows-storage-categories.md).

## Troubleshooting

### `Get-CimInstance` or volume discovery fails

Confirm `powershell.exe` is on PATH and CIM/WMI services are available. Run the app as the normal user, not through WSL. A restricted enterprise environment may block CIM; no fallback to `/proc` or `lsblk` exists on Windows.

### The interactive UI does not start

Build first, use a real terminal (stdout must be a TTY), and confirm Ink installed. Use `node bin/fix-storage.cjs --plain` for noninteractive output. Pixel/kitty graphics are not used on Windows.

### Explorer does not reveal an item

The path may have disappeared or become inaccessible. Explorer is started without a command shell; spaces and Unicode are passed as process arguments. Explorer process startup does not prove that a third-party shell replacement opened the expected view.

### An item cannot be recycled

It may be protected, locked by another process, denied by ACLs or Controlled Folder Access, on an unsupported network/removable volume, already missing, or cancelled in a Windows dialog. The app reports failure and does not permanently delete it. Close the owning app or use Windows' own management tools; do not run this port elevated to force removal.

### Sizes differ from Explorer or `du`

This port currently uses logical file sizes. NTFS cluster rounding, compression, sparse files, hard links, ACL-denied content, and independently overlapping estimates can produce different totals. The JSON `measured` field is a scan estimate, not a second filesystem-capacity measurement.

### Garbled symbols

Use a current Windows Terminal and a UTF-8 capable monospace font. PowerShell JSON uses UTF-8 for Recycle Bin operations. Character rendering still needs validation in legacy Windows Console and non-English locales.

## Outstanding testing requirements

A separately requested test phase should cover, at minimum:

1. Typecheck/build and package installation on supported Node versions.
2. CLI help, invalid arguments, plain/JSON schemas, demo, dry-run, and non-TTY routing.
3. Windows 10 and 11 x64 volume inventories: C:, secondary/internal, USB/removable, folder mounts, duplicate mount paths, disconnected and unassigned volumes.
4. NTFS, exFAT, FAT32, ReFS where available, BitLocker unlocked/locked, and unsupported network Recycle Bin behavior.
5. Deep/long paths, Unicode, hidden/system attributes, sparse/compressed files, large files, junctions, symlinks, hard links, cloud placeholders, and files vanishing mid-scan.
6. Cancellation and memory/I/O behavior on 512 GB, 1 TB, and 2 TB drives, large `node_modules`, game libraries, and developer caches.
7. Permission denied, sharing locks, Controlled Folder Access, read-only media, Recycle Bin disabled/full, and user cancellation.
8. COM vtable/marshaling, callback evidence (`PreDeleteItem`, one `PostDeleteItem`, `FinishOperations`, abort state), Shell item path identity, volume/bin preflight, `NukeOnDelete`, fixed/removable/network volume handling, and proof that every successful cleanup is restorable while no failure triggers permanent deletion or Recycle Bin emptying.
9. Exact confirmation plans, timeout/cancel behavior, nested-path batches, duplicate paths, and dry-run with filesystem snapshots proving no changes.
10. Explorer paths with spaces/Unicode and inaccessible/missing items.
11. Windows Terminal, PowerShell 5.1/7, Windows Console, keyboard navigation, resizing, Unicode, and non-English locales.

None of these checks has been performed in this development phase.

### Commands for the later approved validation phase

Do not run these during development. Use a disposable Windows 10/11 x64 environment and paths created only for validation.

```powershell
Set-Location C:\coding\gg_project\terminal-clean\fix-storage-windows

# Static/build and read-only CLI checks.
npm ci
npm run typecheck
npm run build
node bin/fix-storage.cjs --help
node bin/fix-storage.cjs --demo --plain
node bin/fix-storage.cjs --demo --json
node bin/fix-storage.cjs --drives --json

# Compile-check the native bridge without processing user paths.
$source = Join-Path $PWD 'scripts\RecycleBin.Native.cs'
powershell.exe -NoLogo -NoProfile -NonInteractive -STA -Command "Add-Type -LiteralPath '$source'"

# Synthetic Recycle Bin fixture. Create it only in an approved test environment.
$fixtureRoot = Join-Path $env:TEMP 'fix-storage-validation'
New-Item -ItemType Directory -Force -Path $fixtureRoot | Out-Null
Set-Content -LiteralPath (Join-Path $fixtureRoot 'sample.txt') -Value 'synthetic fixture'

# Preflight/dry-run in the app, then use the interactive UI with d/d or c/c.
npm start -- --dry-run

# Direct native-helper check on the synthetic fixture only, after app review.
@((Join-Path $fixtureRoot 'sample.txt')) |
  ConvertTo-Json -Compress |
  powershell.exe -NoLogo -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File (Join-Path $PWD 'scripts\windows-recycle-bin.ps1')

# Confirm the path is gone, then restore it manually from the Windows Recycle Bin.
Test-Path -LiteralPath (Join-Path $fixtureRoot 'sample.txt')
```

Do not use the direct native-helper command on real files, and do not empty the Recycle Bin as part of validation.

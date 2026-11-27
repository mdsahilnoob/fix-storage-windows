# Windows guide

## Support statement

This port targets Windows 10 and Windows 11 on x64 with Node.js 20.11+. The implementation is **untested and unverified** at this stage. No claim is made that every drive type, terminal, cache location, permission case, or Recycle Bin operation works on a particular machine yet.

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
5. The native bridge uses `IFileOperation` with `FOFX_RECYCLEONDELETE` and `FOFX_ADDUNDORECORD`. `PreDeleteItem` requires `TSF_DELETE_RECYCLE_IF_POSSIBLE`; `PostDeleteItem` requires a successful HRESULT, recycle flags, and a non-null Recycle Bin item.
6. Successful and unsuccessful paths are recorded. Source disappearance alone never counts as success. Locked, denied, unavailable, cancelled, or unsupported items are not retried with another mechanism.

Moving an item to the Recycle Bin does **not** reclaim its space. Windows still accounts for it until the user independently empties or restores items through Windows. This app has no empty-Recycle-Bin operation.

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
8. Static and behavioral proof that every successful cleanup is restorable and that no failure triggers permanent deletion or Recycle Bin emptying.
9. Exact confirmation plans, timeout/cancel behavior, nested-path batches, duplicate paths, and dry-run with filesystem snapshots proving no changes.
10. Explorer paths with spaces/Unicode and inaccessible/missing items.
11. Windows Terminal, PowerShell 5.1/7, Windows Console, keyboard navigation, resizing, Unicode, and non-English locales.

None of these checks has been performed in this development phase.

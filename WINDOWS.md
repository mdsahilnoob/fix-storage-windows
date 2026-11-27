# Windows guide

## v1 product scope

fix-storage v1 is **READ-ONLY**. It analyzes storage, estimates potential cleanup opportunities, and presents recommendations. It never deletes, recycles, moves, renames, empties, or modifies files.

**Do not expect cleanup functionality.** v1 has no hidden cleanup mode.

## Implemented read-only functionality

- CIM-based drive and volume discovery.
- Drive letters, folder-mounted volumes, volume GUIDs and volume types.
- Disk-capacity, used and available reporting.
- Recursive directory scanning with progress and cancellation.
- Unicode and long-path handling for inspected paths.
- Permission-denied and unreadable-path reporting.
- Category classification, large-item reporting and culprit discovery.
- Temporary/cache/developer/game/storage category identification.
- Possible duplicate candidates grouped by name and byte size; file contents are not read.
- Recommendations with reasons and estimated opportunity sizes.
- JSON and plain-text reports.
- Ink terminal UI with drive selection, browsing, filtering and refresh.
- Explorer reveal for selected paths.

## Explicitly not implemented in v1

- File or directory deletion.
- Recycle Bin or Trash operations.
- Moving, renaming, emptying, permission or attribute changes.
- Registry or system-policy changes.
- PowerShell cleanup helpers.
- IFileOperation deletion methods.
- Package-manager or system cleanup commands.
- Automatic application of recommendations.

The earlier Recycle Bin native bridge remains in the repository as archived source for future review. It is not imported by v1 runtime paths and is excluded from the published package.

## Requirements

- Windows 10 or Windows 11, x64
- Node.js 20.11 or newer, including npm
- Windows PowerShell 5.1 (`powershell.exe`) for read-only CIM volume discovery
- Windows Terminal, PowerShell, PowerShell 7, or Windows Console

## Installation and setup

```powershell
Set-Location C:\path\to\fix-storage-windows
npm install
npm run build
```

Run directly:

```powershell
node bin/fix-storage.cjs --demo
node bin/fix-storage.cjs --plain
```

Install a user-level npm command:

```powershell
npm install --global .
fix-storage --help
```

No administrator PowerShell is required or recommended.

## CLI behavior

Safe options:

```powershell
fix-storage --help
fix-storage --demo
fix-storage --plain
fix-storage --json
fix-storage --drives
fix-storage --drive C:\
```

Cleanup-implying options are rejected before any application module is loaded:

```text
--clean --cleanup --delete --remove --recycle --trash
--apply --execute --empty-trash --empty-recycle-bin --purge --dry-run
```

They print an explanation that automated cleanup is not supported in v1.

## Accounting

`movedToRecycleBinBytes` and reclaimed-byte accounting have been removed from v1. Reports and the UI show:

- `estimated cleanup opportunity`
- `potentially recoverable space`
- `estimated category size`
- `recommended review`

No successful cleanup count is displayed.

## Troubleshooting

### `Get-CimInstance` or volume discovery fails

Confirm `powershell.exe` is available and CIM/WMI services are working. A restricted enterprise policy may block CIM. There is no `/proc` or `lsblk` fallback on Windows.

### The interactive UI does not start

Build first and use a real terminal. Use `node bin/fix-storage.cjs --plain` for noninteractive analysis.

### Permission errors during scanning

Unreadable paths are reported or counted as System data. Run as the normal user; do not elevate to force access.

### Sizes differ from Explorer

Category values are logical-size estimates. NTFS cluster rounding, compression, sparse files, hard links, ACL-denied paths, and overlapping roots can produce different totals.

### Garbled symbols

Use a current Windows Terminal with a UTF-8 capable monospace font.

## Known limitations

- Not allocated-cluster accounting or alternate-stream accounting.
- Not every third-party cache or launcher is recognized.
- Network, offline, BitLocker-locked and unusual filesystem states are reported conservatively.
- No Known Folder API integration; standard profile names and environment variables are used.
- Windows Terminal, PowerShell 5.1/7 and legacy Windows Console rendering remain to be validated on supported builds.
- No runtime validation has been performed in this development phase.

## Validation still required

A later disposable Windows 10/11 x64 VM phase should validate:

1. Dependency installation with `--ignore-scripts`, typecheck and build.
2. CLI help, safe options, rejection of cleanup flags, JSON and plain output.
3. Drive discovery on fixed, removable, folder-mounted and disconnected volumes.
4. Scanning deep, long, Unicode and permission-denied paths.
5. Classification, large-file reporting, duplicate-candidate generation and recommendation text.
6. Progress, cancellation and rescan behavior.
7. UI rendering, keyboard navigation and Explorer reveal.
8. Static confirmation that no cleanup API is reachable from v1 runtime paths.

Do not run cleanup or deletion tests against v1. There is no cleanup operation to validate.

### Safe read-only commands for that phase

```powershell
Set-Location C:\path\to\fix-storage-windows
npm ci --ignore-scripts
npm run typecheck
npm run build
node bin/fix-storage.cjs --help
node bin/fix-storage.cjs --demo --plain
node bin/fix-storage.cjs --demo --json
node bin/fix-storage.cjs --drives --json
```

No fixture creation or filesystem mutation is required for these checks.

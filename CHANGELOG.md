# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## v1 — read-only product scope (pending validation)

**v1 is a read-only storage analysis and cleanup recommendation application. Automated cleanup is no longer supported on any platform. No hidden cleanup mode or activation flag exists.**

### Added

- Windows 10/11 x64 platform detection, PowerShell/CIM volume discovery, drive letters, folder mount points, volume GUIDs, removable drives, capacity reporting and multi-drive selection.
- Asynchronous recursive scanning with bounded I/O, cancellation, long-path/Unicode handling, permission reporting and reparse-point avoidance.
- Windows storage layouts for temporary files, AppData, application caches, developer tools/caches/stores, game storage, personal folders, secondary drives, system data and existing Recycle Bin usage reporting.
- Windows-aware classification and modification-time metadata that is never presented as reliable last-opened evidence.
- Informational cleanup recommendations with exact paths, reasons and estimated opportunity sizes.
- Possible duplicate-file candidates grouped by name and byte size; contents are never read or hashed.
- Native Explorer open/reveal integration without shell-interpolated filenames.
- Interactive Ink/React terminal UI with drive selection, category browsing, culprit discovery, filtering, recommendations and refresh.
- `--plain`, `--json`, `--drives`, `--drive`, `--demo` and `--help` analysis modes.

### Removed

- All automated file and directory cleanup, deletion and recycling.
- Permanent cache/Trash deletion and Recycle Bin-only cleanup workflows.
- Two-step cleanup confirmation and cleanup progress indicators.
- `--dry-run` and all cleanup-implying CLI options, which are now rejected before application modules load.
- Reclaimed-byte and successful-cleanup accounting.

### Changed

- Category sizes, potential savings and duplicate candidates are explicitly estimates.
- Reports use read-only terminology and identify `mode: read-only-analysis-and-recommendations`.
- The archived native Recycle Bin bridge is excluded from runtime paths and the published package.
- The Windows UI uses Ink because Pixel 0.3.1 has no Windows runtime.

### Original project history

The sections below are inherited from the upstream `fix-storage` baseline for attribution and comparison. They describe the original macOS/Linux application, not verification of this Windows port.

### Added (upstream)

- Linux support (x86_64 and arm64). Categories follow Linux conventions (XDG folders, Flatpak, Snap, `~/.local/share`, `~/.config`, `~/.cache`), System data lists where it is (`/usr`, package caches, the journal, crash dumps, swap) with the command that shrinks each, and removed items go to the freedesktop.org trash, so the file manager can put them back.
- Multiple drives on Linux: every mounted drive can be scanned on its own. `v` or `1`–`9` switch drives, `--drive` picks one at start, and `--drives` lists them along with partitions that are not mounted. A drive mounted twice (a bind mount, btrfs subvolumes) is measured once, and another drive mounted inside a folder is not counted in it.
- Dual boot: a mounted Windows partition, another Linux install, or an EFI/boot partition is shown look only, with Windows-aware labels (`hiberfil.sys`, `pagefile.sys`, `WinSxS`, `Windows.old`, Windows Update downloads). A read-only NTFS mount says Windows may be hibernated (fast startup).

### Fixed (upstream)

- The installer now checks the downloaded package against the release's published `.sha256` and stops on a mismatch.
- The installer works on Linux: it checks with `sha256sum`, needs `unzip`, and unpacks the graphics runtime on the same filesystem as the install, so a tmpfs `/tmp` no longer breaks it.

## [0.1.0] - 2026-11-14

### Added

- Interactive disk view with a live dot-matrix meter, a category list and a folder browser you can dive into at any depth.
- Culprit finder: shows which nested folder or file holds most of a folder's space; `g` jumps straight to it.
- Labels on every item (`junk`, `unused`, `system`) with a one-line reason, plus a filter (`f`) to show only junk and unused.
- Last-used ages from Spotlight's last-opened dates, falling back to modification time.
- Reveal in Finder, move to Trash, and delete for good (caches and Trash only), each behind a second keypress.
- One-step clearing of caches and emptying the Trash.
- `--dry-run`, `--demo`, `--plain` and `--json` modes.
- `curl | sh` installer with `--version` and `--uninstall`.

[Unreleased]: https://github.com/govijr/fix-storage/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/govijr/fix-storage/releases/tag/v0.1.0

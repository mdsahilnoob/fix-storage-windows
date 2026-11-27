# fix-storage-windows

A native Windows port of [fix-storage](https://github.com/govijr/fix-storage), for inspecting disk usage and moving explicitly confirmed cleanup candidates to the **Windows Recycle Bin**.

> **Development status:** the Windows implementation is present but has not been tested or verified. No tests, benchmarks, deletion experiments, or automated verification were run during this porting phase. See [WINDOWS.md](WINDOWS.md) for limitations and the outstanding validation matrix.

## Safety model

- Every real Windows cleanup operation uses the Windows Recycle Bin.
- There is no permanent-delete option or fallback.
- The app never empties the Recycle Bin.
- Cleanup requires a second keypress after showing the exact paths, item count, estimated size, and destination.
- `--dry-run` and `--demo` do not change filesystem contents.
- Windows, installed-program locations, boot/recovery data, profile roots, volume roots, and Recycle Bin contents are protected.
- Junctions and symbolic links are not traversed or accepted for cleanup.

Read [docs/windows-security.md](docs/windows-security.md) before working on cleanup code.

## Requirements

- Windows 10 or Windows 11, x64
- Node.js 20.11 or newer, including npm
- Windows PowerShell 5.1 (`powershell.exe`) for volume discovery and the STA C# Recycle Bin bridge; PowerShell 7 can be used to launch the CLI
- Windows Terminal, PowerShell, PowerShell 7, or Windows Console for the character UI

## Install from source (PowerShell)

```powershell
Set-Location C:\path\to\fix-storage-windows
npm install
npm run build
node bin/fix-storage.cjs --demo
```

The original Pixel-specific UI entry files are preserved for reference but excluded from Windows builds because Pixel 0.3.1 has no Windows runtime. Windows uses the Ink character renderer instead, so no unsupported Pixel postinstall or native binary is needed.

To link the `fix-storage` command into npm's user-level global directory:

```powershell
npm install --global .
fix-storage --help
```

No administrator PowerShell is required or recommended. Protected files that cannot be read or recycled are reported and left alone.

## Usage

```powershell
fix-storage                    # interactive drive scan
fix-storage --dry-run          # interactive; no filesystem changes
fix-storage --demo             # synthetic data; reads and changes nothing
fix-storage --plain            # text storage report
fix-storage --json             # JSON storage report
fix-storage --drives           # volumes, capacities and unassigned volumes
fix-storage --drives --json    # machine-readable volume report
fix-storage --drive C:\        # select by drive path
fix-storage --drive 2          # select the second reported drive
fix-storage --plain --drive "D:\Games"
```

Drive selectors are a one-based number, displayed name, volume label, mount point, volume GUID, or an absolute path on the volume. `--dry-run` is an interactive cleanup preview; `--plain`, `--json`, and `--drives` never perform cleanup regardless of mode.

### Interactive keys

| Key | Action |
| --- | --- |
| Up/Down or `j`/`k` | Move through categories or items |
| Right/Enter | Enter the item pane or open a folder |
| Left/Escape | Go back |
| Tab | Switch panes |
| PageUp/PageDown | Move ten rows |
| `g` | Jump to the dominant storage culprit |
| `f` | Show only junk/unused, or show everything |
| `o`/Space | Open a folder or reveal a file in Explorer |
| `d`/Delete/Backspace | Select an item; press again to confirm Recycle Bin move |
| `c` | Prepare eligible cache cleanup; press again after reviewing exact paths |
| `v`/`V` | Next/previous drive |
| `1`–`9` | Select a drive |
| `r` | Rescan |
| `q`/Ctrl+C | Quit |

The Windows Ink renderer does not implement the original pixel meter, mouse actions, or Home/End shortcuts. Navigation, reports, culprit browsing, Explorer integration, dry-run, and confirmation workflows are retained in character form.

## Reports and accounting

The JSON schema preserves the original categories and fields. Windows drive objects additionally expose `driveType` when available. Category values are estimates based on logical file sizes, not NTFS allocated-cluster totals. Independently measured categories can exceed filesystem usage; unmeasured and unreadable space is assigned to System data.

Windows access timestamps are not treated as last-opened dates. The interface displays **modified** time and does not recommend deletion solely because a file has an old timestamp.

## Documentation

- [WINDOWS.md](WINDOWS.md): installation, behavior, limitations, troubleshooting, and validation requirements
- [Architecture](docs/windows-architecture.md)
- [Cleanup security](docs/windows-security.md)
- [Storage categories](docs/windows-storage-categories.md)
- [Compatibility audit](docs/windows-compatibility.md)
- [Progress and implementation status](docs/windows-progress.md)
- [Changelog](CHANGELOG.md)

## License

MIT, matching the original project. The original `fix-storage` repository is unchanged; this directory contains the independent Windows port.

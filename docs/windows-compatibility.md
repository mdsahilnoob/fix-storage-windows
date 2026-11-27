# Original-code compatibility audit

## Repository boundary

At inspection, `fix-storage` was a clean Git repository on `main`; `fix-storage-windows` existed as an empty non-Git directory. Only project content was copied, never `.git`. No original file was modified, no dependencies were installed in the original, and no tests were run in either directory.

## Original architecture

The original CLI shim routes to plain output or a Pixel React terminal process. `Store` coordinates drive loading, scanning, category/folder navigation, enrichment, confirmation, cleanup and dry-run. Core modules provide category models, POSIX drive discovery, layouts, `du` measurement, classification, Finder/file-manager reveal, macOS/freedesktop Trash, and permanent cache/Trash deletion. One Bun test file covers disk accounting and dry-run behavior.

Reused in the port:

- CLI option shapes and plain/JSON schemas;
- category IDs/order/tiers, `Drive`, `Layout`, `Item`, `ScanSnapshot` and result models;
- store navigation, cancellation tickets, caching, two-step actions, demo and dry-run;
- classification concepts, culprit behavior and text formatting;
- Unix/macOS implementations as read-only reference behavior inside this port.

## Incompatibilities found

| Original assumption | Native Windows replacement |
| --- | --- |
| Only `darwin` and `linux` allowed | Windows-only x64 package metadata for the independent port |
| `!IS_MAC` means Linux | Explicit `IS_WINDOWS` and platform labels |
| `/proc/self/mountinfo`, `lsblk`, UDisks | CIM `Win32_Volume`/`Win32_MountPoint`, GUID identity, Disk Management advice |
| Unix `du` and `ps` | Asynchronous Node walker and depth-limited culprit walk |
| POSIX case-sensitive `/` paths | Case-insensitive normalized Windows containment and separator-aware ancestry |
| `stat.blocks * 512` | Logical `stat.size` on Windows (allocated-size limitation documented) |
| Recycled cache bytes counted as freed | Separate `movedToRecycleBinBytes`; `freed` only from fresh disk measurement |
| Spotlight or Linux atime | Modification time only, never labelled last-opened |
| Finder/D-Bus/xdg-open | Explorer open/select process arguments without a shell |
| macOS/freedesktop Trash | Native C# `IFileOperation` bridge with pre-delete and post-delete recycle-only guards |
| Permanent caches/Trash deletion | Prohibited on Windows; all cleanup recycles and Recycle Bin clearing is disabled |
| Original bulk clean skipped central removal guard | Both item and bulk paths call `cannotRemoveWindows` and provider validation |
| Pixel-only renderer | Windows Ink renderer using the same Store; Pixel entry files preserved as reference but excluded from builds |
| `rm -rf dist` | Build script removed from the Windows package; no recursive deletion API in package configuration |

## CLI compatibility

Preserved: interactive mode, `--demo`, `--dry-run`, `--plain`, `--json`, `--drives`, `--drive <value>`, `--drive=<value>`, help and exit-code handling. Windows help now describes Windows drives and terminals. Drive selectors accept native paths and volume metadata. JSON retains existing fields and adds optional `driveType`; unassigned-volume `mount` advice is no longer a UDisks command.

No noninteractive cleanup command was added. Plain/JSON modes remain read-only.

## Intentional behavior differences

- Every Windows cleanup is restorable through the Recycle Bin; there is no cache permanent-delete exception.
- Recycle Bin usage cannot be emptied through this app.
- Moving caches transfers estimated bytes to Recycle Bin accounting rather than reporting reclaimed space.
- Logical rather than allocated file size is used.
- Old modification time alone does not imply `unused` on Windows.
- Windows Terminal uses character graphics and keyboard input; Pixel animation/mouse and Home/End are not reproduced.
- Explorer reveal confirms process startup, not the subsequent Shell window's behavior.

## Risk review

Highest-risk boundaries are cleanup containment, reparse points, Shell failure semantics and changed files between planning and confirmation. The implementation uses repeated policy checks, exact prepared path arrays, structured JSON stdin, pre/post-delete destination evidence, per-item results and no fallback. Runtime behavior remains unverified and needs the separate matrix in `WINDOWS.md`.

# Compatibility audit

## Repository history

At initial inspection, `fix-storage` was a clean Git repository on `main` and `fix-storage-windows` was an empty directory. Only project content was copied, never `.git`. The Windows port was later initialized as its own Git repository on `main`. No original file was modified, no dependencies were installed in the original, and no tests were run in either directory.

## Original architecture retained

- category IDs, order and tier model;
- `Drive`, `Layout`, `Item` and `ScanSnapshot` data structures;
- `Store` navigation, cancellation, caching and filtering;
- plain and JSON presentation;
- demo scan model;
- classification concepts;
- culprit analysis;
- Unix/macOS reference source, preserved but non-authoritative for v1.

## v1 product change

The original cleanup workflows have been replaced by read-only recommendations. This is a deliberate product decision for v1, not a runtime toggle.

| Earlier behavior | v1 behavior |
| --- | --- |
| Permanent cache/Trash deletion on Unix-like hosts | No deletion; recommendation estimates only |
| Recycle Bin-only Windows cleanup | No cleanup; Recycle Bin reported as occupied storage |
| Two-step deletion confirmation | No confirmation dialogs because no action is performed |
| `fs.rm` / `fsp.rm` cleanup paths | Removed from active v1 modules |
| `IFileOperation` bridge | Archived, unreachable, not published |
| `--dry-run` | Rejected as a cleanup-implying option |
| `rm -rf dist` | Build script removed from package configuration |

## CLI compatibility

Preserved safe options: interactive analysis, `--demo`, `--plain`, `--json`, `--drives`, `--drive`, help and exit-code handling. Cleanup-implying options are rejected before application modules load.

JSON retains the original analysis fields and adds a `mode` of `read-only-analysis-and-recommendations` plus `cleanup.automatedCleanupSupported: false`. Text output includes an explicit read-only notice.

## Intentional compatibility differences

- No cleanup operation is available on any platform.
- No successful cleanup count or freed-byte total is displayed.
- Modification time is not presented as last-opened time.
- Pixel graphics and mouse interactions are not reproduced by the Ink renderer.
- macOS and Linux support in this repository is source-level only; the package targets Windows x64.

## Security summary

V1 has no active mutation backend. Static verification must confirm that no runtime path reaches deletion, recycling, moving, registry changes or cleanup commands. Runtime Windows validation remains outstanding.

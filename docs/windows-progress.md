# Windows port progress

This document tracks implementation status. It is a static development record, not a verification report. No tests, benchmarks, cleanup experiments, or automated verification have been run.

## Repository audit

- [x] Located separate `fix-storage` and `fix-storage-windows` directories.
- [x] Confirmed the original is a clean Git repository and the Windows directory is not a Git repository.
- [x] Copied project content without Git metadata; original files are read-only reference material.
- [x] Audited CLI, scanner, drive discovery, layouts, classification, cleanup, UI, dependencies, and tests.

## Implementation

- [x] Shared platform detection and Windows path semantics.
- [x] Windows volume and multi-drive discovery.
- [x] Windows drive layouts and protected locations.
- [x] Native asynchronous filesystem scanning and culprit discovery.
- [x] Windows classification and modification-time metadata.
- [x] Recycle Bin-only cleanup with confirmation and dry-run.
- [x] Explorer integration.
- [x] Windows terminal renderer and CLI/package adaptation.
- [x] Windows documentation.
- [x] Final independent static safety review and fixes (recycle-only native provider, mounted-volume protection, canonical alias checks, failed-item accounting).

## Design constraints

- No Windows cleanup path may use permanent deletion or empty the Recycle Bin.
- PowerShell is used for fixed CIM volume queries and a fixed C# `IFileOperation` bridge with JSON stdin; filenames never become shell source.
- Junctions and symbolic links are not traversed or offered for cleanup; the PowerShell provider rejects all objects carrying the reparse-point attribute.
- Windows access time is not presented as a last-opened date.
- `@zenbu-labs/pixel` has no Windows runtime; the Windows interactive view uses Ink and the existing application store.

## Outstanding validation

All Windows functionality remains untested until a separately requested test phase. See `WINDOWS.md` for the validation matrix and known limitations.

# Windows port progress

This document tracks implementation status. It is a static development record, not a verification report. No tests, benchmarks, cleanup experiments, or automated verification have been run.

## Repository audit

- [x] Located separate `fix-storage` and `fix-storage-windows` directories.
- [x] Confirmed the original and Windows port are separate repositories; the Windows port was initialized later on `main`.
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

## Static-review repair pass

- [x] Corrected the ESM type import required by the CommonJS/Node16 build.
- [x] Removed unsupported `ChildProcess.destroy()` usage; all native-process settlement is now single-shot and stdin errors kill the child.
- [x] Added native volume/bin preflight before any delete is queued.
- [x] Added exact Shell path identity checks immediately before scheduling deletion.
- [x] Required explicit pre-delete, single post-delete, finish, and no-abort evidence for success.
- [x] Clarified that post-delete evidence is not rollback and warned when a source may already be gone.
- [x] Added a common reparse-aware directory-entry guard before every top-level traversal entry point.
- [x] Added positive moved-path accounting and bounded native-process stdout.
- [x] Made long-path validation consistent and rejected unsupported volume types before cleanup.
- [x] Removed the package's recursive build-directory deletion script to avoid any literal permanent-delete API in package configuration.

None of these repairs has been built or executed.

## Focused P1/P2 repair pass

- [x] `GetVolumePathNameW` is mandatory with no drive-letter fallback; volume GUID resolution is mandatory.
- [x] Per-volume `Volume\{GUID}\NukeOnDelete` uses the brace-delimited GUID; global `NoRecycleFiles` and legacy BitBucket policy checks are separate and fail closed on unverified state.
- [x] Windows file-handle identity checks record volume serial/file index, reject reparse attributes and recheck the Shell item before deletion.
- [x] `movedToRecycleBinBytes` is separate from `freed`; reclamation comes from fresh disk measurement and is shown in UI, CLI output and reports.
- [x] Native stdout is byte-counted and strict result-shape validation rejects malformed or incomplete output.
- [x] Documentation records that Node `lstat` cannot identify every reparse tag and that native predelete checks cover selected cleanup paths.

None of these repairs has been built or executed.

## Second static-review repair pass

- [x] Managed `IFileOperationProgressSink` definition no longer uses `[ComImport]`; consumed COM interfaces remain imported.
- [x] All native wide-string callback parameters declare `UnmanagedType.LPWStr`.
- [x] Native cleanup runs in bounded batches; incomplete/malformed results become `unknown`, never silent success or ordinary failure, and are not retried.
- [x] Native ancestor chain validation accepts only the exact volume mount point as a legitimate reparse root.
- [x] Reclaimed-byte wording changed to net free-space increase observed, with a warning about concurrent activity.
- [x] Confirmed `HEAD`, `origin/main` and `git ls-remote origin main` all resolve to commit `bec3afe`.

None of these repairs has been built or executed.

## Third static-review repair pass

- [x] `CleanResult.errors` now uses a discriminated `failed`/`unknown` outcome type instead of an untagged optional flag.
- [x] `DeleteItem` receives the callback through an `IFileOperationProgressSink`-typed parameter.
- [x] Native batches have configurable timeouts and cancellation; post-start uncertainty is `unknown`, never rollback.
- [x] Native result parsing rejects duplicates, unexpected/missing paths and contradictory success/error fields with Windows case-insensitive matching.
- [x] Documentation reconciles failure semantics, capacity limits, repository history, and future disposable-VM validation scope.

No runtime verification has been performed.

## Outstanding validation

All Windows functionality remains untested until a separately requested test phase. See `WINDOWS.md` for the validation matrix and known limitations.

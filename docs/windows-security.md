# Windows cleanup security

## Non-negotiable invariant

Every real Windows cleanup must use the Windows Recycle Bin. Permanent deletion, forced deletion, recursive deletion APIs, `Remove-Item`, `del`, `rmdir`, direct `$Recycle.Bin` manipulation, Recycle Bin emptying, and fallback deletion after an error are prohibited.

Application code can call only `recycleWindows()` in `src/core/windows/trash.ts`. The lower-level provider is private to that module.

## Native Shell bridge

`scripts/windows-recycle-bin.ps1` accepts UTF-8 JSON paths on stdin and compiles `scripts/RecycleBin.Native.cs` in memory. PowerShell runs with `-STA`; filenames never become script source. The C# bridge uses Windows `IFileOperation` directly, with no third-party trash package or Visual Basic FileIO dialog behavior.

The operation flags are:

- `FOFX_RECYCLEONDELETE`: recycle rather than permanently delete;
- `FOFX_ADDUNDORECORD`: retain Shell undo/restoration information;
- `FOFX_EARLYFAILURE`: stop on the first error;
- `FOF_NOERRORUI`, `FOF_NOCONFIRMATION`, `FOF_SILENT`: suppress Shell UI while the callbacks—not a permanent-delete dialog—decide whether the outcome is acceptable.

Flags alone are not treated as proof. `RecycleGuard` implements both callbacks:

1. `PreDeleteItem` returns `E_ABORT` unless `dwFlags` contains `TSF_DELETE_RECYCLE_IF_POSSIBLE`.
2. `PostDeleteItem` requires a successful `hrDelete`, recycle flags, and a **non-null `psiNewlyCreated`**. Microsoft defines that pointer as the deleted item now in the Recycle Bin; full deletion supplies `NULL`.

An operation without that post-delete evidence is aborted and reported as failed for manual inspection. Node never infers recycling merely from `ENOENT`: success requires the native post-delete confirmation, no aborted operations, and a source-path check. Existing or unconfirmable sources are failures. No other deletion mechanism is attempted.

Microsoft references:

- [`PostDeleteItem` destination semantics](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifileoperationprogresssink-postdeleteitem)
- [`IFileOperationProgressSink`](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nn-shobjidl_core-ifileoperationprogresssink)
- [Windows SDK `FOFX_*` flag definitions](https://raw.githubusercontent.com/tpn/winsdk-10/master/Include/10.0.16299.0/um/ShObjIdl_core.h)

Runtime COM interop and Shell behavior remain unverified until the separately approved test phase.

## Defense in depth

1. **Layout:** only measured roots and explicitly named cache roots are candidates for bulk plans.
2. **Store:** System data and Recycle Bin categories are blocked; no overlapping operations; second keypress required.
3. **Plan:** category cleanup enumerates direct children only and excludes nested roots and aliases.
4. **Policy:** `cannotRemoveWindows()` uses absolute, case-insensitive containment and protected-tree checks.
5. **Provider:** `validateWindowsRecycle()` repeats policy checks, rejects final links and canonical/ancestor aliases, and reruns policy on the canonical target.
6. **Process boundary:** a fixed script and JSON stdin prevent filenames becoming PowerShell code.
7. **Shell operation:** forced recycle plus pre-delete and post-delete recycle-only guards is mandatory; errors never invoke a fallback.

Both category and item paths invoke the same policy. This deliberately closes the original bulk-clean path's reliance on root construction alone.

## Confirmation requirements

Before a real or dry-run action, the Windows UI shows:

- every exact selected source path, without truncation;
- selected item count (files and directories are both items);
- estimated logical byte total;
- explicit Windows Recycle Bin wording and restoration expectation;
- dry-run status when applicable.

A matching second keypress within 15 seconds is required. Preparing a category plan does not arm until enumeration finishes. The prepared item list is passed to execution so the user confirms the same paths that are submitted. Paths are revalidated because files and permissions can change after review.

## Dry-run and demo

`--dry-run` reads the real disk but does not call the Recycle Bin provider. `--demo` uses synthetic drives and never starts the real provider. Neither mode should alter filesystem contents. These are security invariants, not merely presentation details, and remain untested until the separate validation phase.

## Protected locations

The native policy protects volume roots and Windows/system-managed trees, including:

- `Windows`, boot, recovery, System Volume Information and `$Recycle.Bin`;
- `Program Files`, `Program Files (x86)` and `ProgramData`;
- page/hibernation/swap files through System classification and root protection;
- user profile roots and all measured root directories;
- standard Documents, Desktop, Pictures, Videos, Music and Downloads roots;
- other volumes, aliases, read-only volumes, and paths outside measured roots;
- junctions and symbolic links immediately before mutation.

Folder-mounted volumes use their actual mount root for these checks, not just the containing drive root. Canonical volume-GUID results are translated back through the selected mount before alias comparison. Personal descendants explicitly selected in a valid workflow are still Recycle Bin-only. Their presence in a category is not permission for automatic deletion.

## Error handling

Access denial, sharing locks, read-only media, disabled/full Recycle Bin settings, unsupported network locations, missing paths, Shell cancellation, bridge startup failures and unsuccessful source confirmation all produce failure rather than another deletion attempt. Results are reconciled per submitted path; a path without affirmative native recycle evidence is treated as failed.

Shell operations are not transactions. Windows may handle some objects before another object fails, so a later rescan is required for exact state. Failed bulk items remain visible in the UI. No code attempts to roll back through permanent deletion.

## User privileges and external tools

Do not run the app elevated to force cleanup. It does not bypass ACLs, take ownership, clear read-only attributes, close processes, unlock files, mount volumes, change Recycle Bin settings, or disable Controlled Folder Access. Windows' own application/package/game management tools are recommended for managed data. Cleanup requires an interactive Windows user Recycle Bin context, not a Windows service or headless host.

## Development review rule

Any new cleanup feature must name its route through `recycleWindows()` and its policy checks. A direct filesystem deletion API, Shell permanent-delete flag, removal of either recycle-only callback, or empty-Recycle-Bin API is a security regression. Tests in a later phase must spy on all mutation providers and use synthetic fixtures approved for that phase; development of this port did not include deletion experiments.

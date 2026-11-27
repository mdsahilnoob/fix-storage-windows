# Windows cleanup security

## Non-negotiable invariant

Every real Windows cleanup must use the Windows Recycle Bin. Permanent deletion, forced deletion, recursive deletion APIs, `Remove-Item`, `del`, `rmdir`, direct `$Recycle.Bin` manipulation, Recycle Bin emptying, and fallback deletion after an error are prohibited.

Application code can call only `recycleWindows()` in `src/core/windows/trash.ts`. The lower-level provider is private to that module.

## Native Shell bridge

`scripts/windows-recycle-bin.ps1` accepts UTF-8 JSON paths on stdin and compiles `scripts/RecycleBin.Native.cs` in memory. PowerShell runs with `-STA`; filenames never become script source. The C# bridge uses Windows `IFileOperation` directly, with no third-party trash package or Visual Basic FileIO dialog behavior.

**Preflight before deletion:** `GetVolumePathNameW` is mandatory; failure stops immediately with no fallback to a containing drive letter. The resulting mount point is resolved with `GetVolumeNameForVolumeMountPointW` to a brace-delimited volume GUID, so folder-mounted volumes are checked against their own volume identity. Unknown, no-root, network, optical and RAM drives are rejected, `SHQueryRecycleBinW` must confirm a Recycle Bin for that mount, and policy state is verified. If any check fails, no delete is queued and the item is untouched. This narrows, but does not make atomic, the validation-to-operation race.

**Policy checks are separate and fail closed:**

1. Per-volume: `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket\Volume\{GUID}\NukeOnDelete`. The braces around the GUID are part of the key name and are preserved exactly from `GetVolumeNameForVolumeMountPointW`.
2. Global policy: `NoRecycleFiles` under `HKCU` and `HKLM\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer`.
3. Legacy global setting: `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket\NukeOnDelete`.

A missing key or value is the documented default (recycling enabled). An unreadable key, malformed value type, unexpected value, or failure to resolve the volume GUID is an **unverified state** and stops cleanup before any Shell operation.

**File identity:** the bridge opens the target with `FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT`, rejects any `FILE_ATTRIBUTE_REPARSE_POINT`, and records the NTFS volume serial plus 64-bit file index. After resolving the Shell item, its `SIGDN_FILESYSPATH` must match the confirmed path and its file identity must match again. A mismatch cancels the operation. This is a best-effort narrowing of the time-of-check/time-of-use gap, not an atomic guarantee.

The operation flags are:

- `FOFX_RECYCLEONDELETE`: recycle rather than permanently delete;
- `FOFX_ADDUNDORECORD`: retain Shell undo/restoration information;
- `FOFX_EARLYFAILURE`: stop on the first error;
- `FOF_NOERRORUI`, `FOF_NOCONFIRMATION`, `FOF_SILENT`: suppress Shell UI while the callbacks—not a permanent-delete dialog—decide whether the outcome is acceptable.

Flags alone are not treated as proof. `RecycleGuard` records callback evidence:

1. `PreDeleteItem` must be received with `TSF_DELETE_RECYCLE_IF_POSSIBLE`; otherwise it returns `E_ABORT` before deletion proceeds.
2. `PostDeleteItem` must be received exactly once with a successful `hrDelete`, recycle flags and a **non-null `psiNewlyCreated`**. Microsoft defines that pointer as the deleted item now in the Recycle Bin; full deletion supplies `NULL`.
3. `FinishOperations` must be received and succeed, with no aborted operations.

`PostDeleteItem` is evidence, **not a rollback mechanism**: it runs after deletion. If it reports a missing destination, the source may already have been permanently deleted; the user is warned to inspect manually rather than being told the item was left untouched. Node never infers recycling merely from `ENOENT`: success requires all native confirmations, no aborted operations, and a source-path check. Existing or unconfirmable sources are failures. No other deletion mechanism is attempted.

These controls make unsupported and uncertain volumes fail closed before deletion, but source code alone cannot prove that Windows will never violate forced recycle behavior because of an OS or Shell defect. Runtime validation of that guarantee remains required before real-file use.

Microsoft references:

- [`PostDeleteItem` destination semantics](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifileoperationprogresssink-postdeleteitem)
- [`IFileOperationProgressSink`](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nn-shobjidl_core-ifileoperationprogresssink)
- [Windows SDK `FOFX_*` flag definitions](https://raw.githubusercontent.com/tpn/winsdk-10/master/Include/10.0.16299.0/um/ShObjIdl_core.h)
- [`GetFileInformationByHandle` volume serial and file index](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileinformationbyhandle)
- [`SHQueryRecycleBinW`](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shqueryrecyclebinw)
- Observed Windows 10/11 per-volume `Volume\{GUID}\NukeOnDelete` key format and global `NoRecycleFiles` policy: <https://www.elevenforum.com/t/enable-or-disable-permanently-delete-instead-of-recycle-bin-in-windows-11.11007/>

Runtime COM interop and Shell behavior remain unverified until the separately approved test phase.

## Defense in depth

1. **Layout:** only measured roots and explicitly named cache roots are candidates for bulk plans.
2. **Store:** System data and Recycle Bin categories are blocked; no overlapping operations; second keypress required.
3. **Plan:** category cleanup enumerates direct children only and excludes nested roots and aliases.
4. **Policy:** `cannotRemoveWindows()` uses absolute, case-insensitive containment and protected-tree checks.
5. **Provider:** `validateWindowsRecycle()` repeats policy checks, rejects final links and canonical/ancestor aliases, and reruns policy on the canonical target.
6. **Traversal boundary:** a shared `windowsEntryKind()` guard runs before every top-level directory open in scanning, browsing, culprit discovery, cache planning and layout discovery; Node-reported links/junctions are not entered. Node does not expose every Windows reparse tag, so non-symlink reparse directories encountered deep in a scan remain a documented limitation; every path selected for cleanup is checked by a native file handle for the reparse attribute before deletion.
7. **Process boundary:** a fixed script and JSON stdin prevent filenames becoming PowerShell code.
8. **Shell operation:** volume/bin preflight, exact Shell path identity, forced recycle, scoped volume types, and pre/post/finish recycle-only guards are mandatory; errors never invoke a fallback.
9. **Positive accounting:** both the native provider and bulk cleaner require explicit moved-path evidence; absence from a failure list is not success.

Both category and item paths invoke the same policy. This deliberately closes the original bulk-clean path's reliance on root construction alone.

## Confirmation requirements

Before a real or dry-run action, the Windows UI shows:

- every exact selected source path, without truncation;
- selected item count (files and directories are both items);
- estimated logical byte total;
- explicit Windows Recycle Bin wording and restoration expectation;
- dry-run status when applicable.

A matching second keypress within 15 seconds is required. Preparing a category plan does not arm until enumeration finishes. The prepared item list is passed to execution so the user confirms the same paths that are submitted. Paths are revalidated because files and permissions can change after review.

## Accounting rule

`freed` means bytes actually reclaimed and is derived only from a fresh `statfs`/disk-space measurement after cleanup. Logical bytes moved into the Recycle Bin are reported separately as `movedToRecycleBinBytes`; they are not added to `freed`. The count `removed` means successfully recycled items, not permanent removals. On Windows, cleanup normally reports reclaimed bytes of zero until the user empties the Recycle Bin through Windows.

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
- network, optical, RAM, unknown, disabled-bin and uncertain volume types before any delete is queued;
- junctions and symbolic links immediately before mutation.

Folder-mounted volumes use their actual mount root for these checks, not just the containing drive root. Canonical volume-GUID results are translated back through the selected mount before alias comparison. Personal descendants explicitly selected in a valid workflow are still Recycle Bin-only. Their presence in a category is not permission for automatic deletion.

## Error handling

Access denial, sharing locks, read-only media, disabled/full Recycle Bin settings, unsupported network locations, missing paths, Shell cancellation, bridge startup failures and unsuccessful source confirmation all produce failure rather than another deletion attempt. Results are reconciled per submitted path; a path without affirmative native recycle evidence is treated as failed.

Shell operations are not transactions. Windows may handle some objects before another object fails, so a later rescan is required for exact state. Failed bulk items remain visible in the UI. No code attempts to roll back through permanent deletion.

## User privileges and external tools

Do not run the app elevated to force cleanup. It does not bypass ACLs, take ownership, clear read-only attributes, close processes, unlock files, mount volumes, change Recycle Bin settings, or disable Controlled Folder Access. Windows' own application/package/game management tools are recommended for managed data. Cleanup requires an interactive Windows user Recycle Bin context, not a Windows service or headless host.

## Development review rule

Any new cleanup feature must name its route through `recycleWindows()` and its policy checks. A direct filesystem deletion API, Shell permanent-delete flag, removal of either recycle-only callback, or empty-Recycle-Bin API is a security regression. Tests in a later phase must spy on all mutation providers and use synthetic fixtures approved for that phase; development of this port did not include deletion experiments.

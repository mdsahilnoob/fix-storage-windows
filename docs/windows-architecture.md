# Windows architecture

## Preservation strategy

The port retains the original category model, `Drive`/`Layout`/`ScanSnapshot` data structures, `Store` workflows, plain/JSON presentation, demo model, classification concepts, and Unix/macOS reference implementations. Windows behavior is selected through centralized `process.platform` constants in `src/core/platform.ts`; the original repository is not changed.

The Windows package intentionally targets `win32`/`x64`. macOS and Linux support remains in the untouched original project, while its source is preserved here as a compatibility reference.

## Backend map

| Area | Shared entry point | Native backend |
| --- | --- | --- |
| Platform | `src/core/platform.ts` | `IS_WINDOWS`, Windows UI labels |
| Paths | callers use platform-aware comparisons | `src/core/windows/paths.ts` |
| Volumes | `src/core/drives.ts` | `windows/drives.ts`, `windows/powershell.ts` |
| Layout | `src/core/layout.ts` | `windows/layout.ts` |
| Measurement | `src/core/scan.ts` and `core/browse.ts` | `windows/scan.ts` |
| Metadata | `usage()` | `windows/metadata.ts` |
| Removal policy | `cannotRemove()` and `clean()` | `windows/permissions.ts` |
| Recycle Bin | `moveToTrash()` and `clean()` | `windows/trash.ts`, `scripts/windows-recycle-bin.ps1`, `scripts/RecycleBin.Native.cs` |
| Explorer | `reveal()` | `windows/reveal.ts` |
| Terminal | `bin/fix-storage.cjs` | `src/main-windows.tsx`, `src/ui/windows-app.tsx` |

## Volume flow

`listDrives()` delegates on Windows to one CIM query. `Win32_Volume` supplies identity, label, filesystem, capacity, free space, drive type and access state; `Win32_MountPoint` adds folder mount points. The backend converts these to the established `Drive` and `Mount` records. Volume identity remains distinct from `DriveKind`: a native Windows system disk is `main`, not the foreign-Windows `windows` kind used by Linux dual-boot inspection.

`diskSpace()` uses `statfs` on the selected mount and the Windows `total - available` formula. CIM space values are a fallback. Boot volumes are look-only. `pickDrive()` delegates to case-insensitive Windows selection instead of reading `/proc`.

## Layout and nested roots

`windowsLayout()` builds roots only on volumes that contain them. The home volume receives standard user folders, AppData, explicitly named caches, package-manager stores, developer tools and game locations. A non-system data volume has a general root plus more specific media/game roots. Nested-root expansion in `startScan()` excludes exact nested roots before measuring a parent, preventing ordinary double counting.

Only known cache roots are `caches`; AppData, Packages, Docker, package stores, game installations and persistent application state remain separate review/system content. `$Recycle.Bin` is visible for accounting but is not a cleanup target.

## Measurement flow

`du()` keeps its original signature for Unix and delegates to `windowsDu()` on Windows. This lets initial scans, folder browsing and category remeasurement share one policy. The Windows walker:

1. Uses `lstat` to inspect the object itself.
2. Does not recurse through symbolic-link/junction directories.
3. Uses extended-length paths for filesystem operations while retaining ordinary display paths.
4. Batches entries and bounds active filesystem operations with `IoLimiter`.
5. Accumulates logical sizes and permission-denied state independently per path.
6. Observes cancellation between batches.

Culprit discovery performs a depth-limited walk and retains only dominant branches plus the largest direct children. Metadata uses `mtimeMs` with `Usage.kind = "changed"`; no access-time guess is labelled as last-opened.

## Cleanup flow

Single-item path:

```text
Ink input -> Store.removeItem -> cannotRemoveWindows -> second confirmation
  -> moveToTrash -> recycleWindows -> validateWindowsRecycle
  -> windowsTrash.moveToTrash -> fixed C# IFileOperation bridge -> pre/post recycle-only guards
```

Category path:

```text
Ink input -> Store.press -> plan -> exact paths/count/bytes displayed
  -> second confirmation -> cleanWindows -> containment + cannotRemoveWindows
  -> recycleWindows -> one structured batch -> per-item result reconciliation
```

`windowsTrash` is private and reached only through `recycleWindows`. Paths are sent as UTF-8 JSON to a fixed STA PowerShell process, which compiles the bundled C# bridge in memory. The bridge uses `IFileOperation` with `FOFX_RECYCLEONDELETE`, `FOFX_ADDUNDORECORD`, no confirmation UI and early failure. `PreDeleteItem` aborts without `TSF_DELETE_RECYCLE_IF_POSSIBLE`; `PostDeleteItem` requires a successful HRESULT, recycle flags and a non-null `psiNewlyCreated`, which Microsoft defines as the item now in the Recycle Bin (NULL for full deletion). Success also requires no aborted operations and source-path removal. Unconfirmed outcomes are failures requiring manual inspection, never fallback deletion.

Windows `deletesForGood()` always returns false, direct permanent deletion throws on Windows, Recycle Bin paths are protected, and `Store.canClear("trash")` is false. Recycled cache bytes transfer to the Recycle Bin estimate rather than being reported as reclaimed disk space.

## Windows renderer

Pixel 0.3.1 has no Windows native package and its postinstall rejects Windows. The launcher therefore loads `main-windows.js` instead of Pixel. That entry dynamically imports ESM-only Ink 5 while leaving the rest of the package CommonJS. `createWindowsApp()` receives Ink components and uses the existing `Store` through `useSyncExternalStore`.

The character UI retains drive/category/folder navigation, reports, culprit details, Explorer reveal, cleanup plans, dry-run and errors. Pixel graphics and mouse behavior are renderer-specific features not reproduced.

## Packaging

Ink and React are runtime dependencies. The two Pixel-specific reference entry files are preserved but excluded from Windows compilation, so Pixel and its unsupported postinstall are not package dependencies. The C# source and fixed PowerShell bridge are included in the npm package and compiled in memory by Windows at cleanup time; no native compiler or trash npm package is required.

# Windows architecture

## v1 scope

fix-storage-windows v1 is a **read-only analysis and recommendation** application. It does not contain an active cleanup workflow. The native Recycle Bin bridge from earlier development is archived source only, is not imported by runtime code, and is excluded from the published package.

The port retains the original category model, `Drive`/`Layout`/`ScanSnapshot` structures, plain/JSON presentation, demo model, classification concepts, and Unix/macOS reference implementations. Windows behavior is selected through `src/core/platform.ts`. The original repository is not changed.

## Backend map

| Area | Shared entry point | Native/Windows backend |
| --- | --- | --- |
| Platform | `src/core/platform.ts` | Windows labels and feature flags |
| Paths | callers use platform-aware comparisons | `windows/paths.ts` |
| Volumes | `core/drives.ts` | `windows/drives.ts`, `windows/powershell.ts` |
| Layout | `core/layout.ts` | `windows/layout.ts` |
| Measurement | `core/scan.ts`, `core/browse.ts` | `windows/scan.ts` |
| Metadata | `usage()` | `windows/metadata.ts` |
| Review policy | `reviewRestriction()` and `core/clean.ts` | `windows/permissions.ts`, `windows/paths.ts` |
| Recommendations | `core/recommendations.ts` | in-memory, read-only |
| Explorer reveal | `reveal()` | `windows/reveal.ts` |
| Terminal | `bin/fix-storage.cjs` | `main-windows.tsx`, `ui/windows-app.tsx` |

Archived, unreachable files: `scripts/windows-recycle-bin.ps1`, `scripts/RecycleBin.Native.cs`, `core/windows/trash.ts` contains only descriptive helpers.

## Volume flow

`listDrives()` delegates on Windows to CIM. `Win32_Volume` supplies identity, label, filesystem, capacity, free space, drive type and access state; `Win32_MountPoint` adds folder mount points. Volume identity remains distinct from `DriveKind`: a native Windows system disk is `main`, not the foreign-Windows `windows` kind used by Linux dual-boot inspection.

`diskSpace()` uses `statfs` on the selected mount with the Windows `total - available` formula. CIM values are a fallback. Boot volumes are look-only. `pickDrive()` uses case-insensitive Windows selection.

## Layout and nested roots

`windowsLayout()` builds roots only on volumes that contain them. The home volume receives standard user folders, AppData, explicitly named caches, package-manager stores, developer tools and game locations. A non-system data volume has a general root plus more specific media/game roots. Nested-root expansion excludes exact nested roots before measuring a parent.

Only known cache roots are `caches`; AppData, Packages, Docker, package stores, game installations and persistent application state remain separate review/system content. `$Recycle.Bin` is visible for accounting only.

## Measurement flow

`du()` keeps its Unix signature and delegates to `windowsDu()` on Windows. The Windows walker:

1. Uses `lstat` to inspect the object itself.
2. Does not recurse through symbolic-link/junction directories.
3. Uses extended-length paths for filesystem operations.
4. Batches entries and bounds active I/O with `IoLimiter`.
5. Accumulates logical sizes and permission-denied state.
6. Observes cancellation between batches.

Culprit discovery performs a depth-limited walk and retains only dominant branches plus the largest direct children. Metadata uses `mtimeMs` with `Usage.kind = "changed"`; access time is not treated as last-opened.

## Recommendation flow

```text
Ink/CLI input -> Store.rescan -> startScan/listFolder/findCulprit
  -> classify + sizes -> reviewItem/reviewCategory
  -> Recommendation { paths, reason, estimatedBytes }
  -> UI note / JSON / plain text
```

`plan()` in `core/clean.ts` only reads direct children and reuses scan sizes. `recommendationForItem()` and `duplicateCandidates()` produce in-memory informational results. Duplicate candidates use name and byte size only; file contents are never read.

No path in this flow imports or calls a mutation provider.

## Windows renderer

Pixel 0.3.1 has no Windows runtime. The launcher loads `main-windows.js`, which dynamically imports ESM Ink while the package remains CommonJS. `createWindowsApp()` receives Ink components and uses `Store` through `useSyncExternalStore`.

The UI provides drive/category/folder navigation, culprit details, filtering, Explorer reveal, read-only recommendations and errors. Pixel graphics and mouse behavior are not reproduced.

## Packaging

Ink and React are runtime dependencies. Pixel reference entry files are excluded from Windows compilation. The archived native bridge is not included in the published package. No native compiler or trash package is required for v1.

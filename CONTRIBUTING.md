# Contributing to the Windows port

The original `fix-storage` repository is a read-only reference. Make Windows-port changes only in this repository and do not copy Git metadata from the original.

## Setup (PowerShell)

```powershell
npm install
npm run demo
```

Use `npm start -- --dry-run` when inspecting a real disk. Do not use real cleanup as a development experiment. Runtime testing requires a separately approved test plan and synthetic fixtures.

## Architecture

Keep shared models and workflows shared. Add native behavior under `src/core/windows` and select it from the existing core entry points rather than scattering `process.platform` checks through the UI. Preserve CLI and JSON compatibility unless a documented Windows difference is necessary.

Useful starting points:

- `src/core/windows/layout.ts`: roots and cache discovery
- `src/core/classify.ts`: conservative labels and reasons
- `src/core/windows/scan.ts`: filesystem traversal
- `src/core/windows/permissions.ts`: protected paths and containment
- `src/core/windows/trash.ts`: the only native Recycle Bin provider
- `src/ui/windows-app.tsx`: Windows character UI

Update `docs/windows-progress.md` and relevant documentation when behavior or architecture changes.

## Rules for anything that removes files

1. Every Windows cleanup goes through `recycleWindows()` and the native Shell `IFileOperation` recycle provider with its non-recycle abort guard.
2. Never add permanent deletion, force deletion, Recycle Bin emptying, or fallback deletion after failure.
3. Both single-item and bulk paths must call the central removal policy; provider-level validation must remain.
4. Every action needs an exact-path review and a second confirmation. `--dry-run` and `--demo` must never change the disk.
5. Volume roots, Windows/system-managed locations, profiles, personal-folder roots, other volumes and reparse points stay protected.
6. New caches must be specific and demonstrably rebuildable. Do not classify persistent AppData, Docker storage, package stores, game libraries, saves or source repositories as generic junk.
7. Do not construct PowerShell/CMD commands from filenames. Use the fixed C# Shell bridge with structured JSON stdin and retain both pre-delete and post-delete recycle checks.

## Documentation and validation

Clearly distinguish implemented code from tested behavior. Do not claim Windows verification until the relevant matrix in `WINDOWS.md` has actually been run. Include OS build, Node/PowerShell versions, volume/filesystem type and paths involved in bug reports. Never include personal file contents or secrets in reports.

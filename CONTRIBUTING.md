# Contributing to the Windows port

The original `fix-storage` repository is a read-only reference. Make Windows-port changes only in this repository and do not copy Git metadata from the original.

## Setup (PowerShell)

```powershell
npm ci --ignore-scripts
npm run typecheck
npm run build
bun test
npm run demo
```

Use `npm run demo` or `node bin/fix-storage.cjs --demo --plain` for development. Cleanup flags such as `--clean`, `--delete`, `--recycle` and `--dry-run` are rejected by v1 and must not be added back.

## Architecture

Keep shared models and workflows shared. Add native behavior under `src/core/windows` and select it from the existing core entry points rather than scattering `process.platform` checks through the UI. Preserve CLI and JSON compatibility unless a documented Windows difference is necessary.

Useful starting points:

- `src/core/windows/layout.ts`: roots and cache discovery
- `src/core/classify.ts`: conservative labels and reasons
- `src/core/windows/scan.ts`: filesystem traversal
- `src/core/windows/permissions.ts`: read-only review restrictions and containment
- `src/core/windows/trash.ts`: descriptive Recycle Bin location only
- `src/ui/windows-app.tsx`: Windows character UI

Update `docs/windows-progress.md` and relevant documentation when behavior or architecture changes.

## Read-only rules

1. Never add a filesystem cleanup API, permanent deletion, Recycle Bin mutation, move, rename, attribute change or permission change.
2. Never add a hidden cleanup mode or a cleanup flag. CLI cleanup requests must continue to exit with an error before application modules load.
3. Do not import the archived native bridge under `scripts/`. It is excluded from the published package and must remain unreachable.
4. Recommendations are informational only. They may show paths, estimates and possible duplicate candidates, but must never claim confirmed duplicates or read file contents.
5. Treat terminal output and JSON reports as text only. They must not invoke a cleanup path.
6. Do not construct PowerShell or CMD commands from filenames. Fixed read-only system queries are the only shell calls in the runtime.
7. Volume roots, Windows/system-managed locations, profiles, personal-folder roots, other volumes and reparse points stay protected and informational.

## Documentation and validation

Clearly distinguish implemented code from tested behavior. Do not claim Windows verification until the relevant matrix in `WINDOWS.md` has actually been run. Include OS build, Node/PowerShell versions, volume/filesystem type and paths involved in bug reports. Never include personal file contents or secrets in reports.

## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## How I tried it

<!-- Do not claim checks that were not run. -->

- [ ] `npm ci --ignore-scripts`
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `bun test`
- [ ] `npm run demo`
- [ ] Relevant items in WINDOWS.md's validation matrix

## Read-only contract

- [ ] No filesystem cleanup API, permanent deletion, recycle, move, rename, attribute or permission change was added
- [ ] No hidden cleanup mode or cleanup flag was added
- [ ] The archived `scripts/` bridge remains unimported and excluded from the package
- [ ] Recommendations remain informational and never read file contents for duplicate claims
- [ ] CLI cleanup requests still fail before application modules load
- [ ] `--demo`, `--plain`, `--json` and the interactive view still change nothing on disk

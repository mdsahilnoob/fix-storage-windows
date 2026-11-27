## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## How I tried it

<!-- Do not claim checks that were not run. -->

- [ ] `npm run typecheck`
- [ ] `npm run demo`
- [ ] `npm start -- --dry-run` on a real disk
- [ ] Relevant items in WINDOWS.md's validation matrix

## If it touches removing files

- [ ] Every real operation goes through `recycleWindows` and the guarded `IFileOperation` recycle provider
- [ ] Both item and bulk paths retain central policy and provider validation
- [ ] Exact paths/count/size are shown and a second confirmation is required
- [ ] `--dry-run` and `--demo` still change nothing on disk
- [ ] No permanent deletion, fallback deletion, or Recycle Bin emptying was introduced

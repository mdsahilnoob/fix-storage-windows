# Scanner contract v1.0

This document defines the normalized result contract for the Windows storage scanner. The current TypeScript scanner is the reference implementation. A replacement scanner must produce the same normalized result for the same corpus, independent of traversal order or implementation language.

## Path identity

- `displayPath` is the normal absolute path used for display and user actions. It is not the extended-length form.
- `pathKey` is the identity used for comparison: absolute, backslash-separated, trailing separator removed, extended-length prefix removed, and lower-cased.
- Path identity is case-insensitive on Windows.
- Extended-length prefixes (`\\?\`) are an I/O detail and must not appear in either field.
- Symlink and junction targets are not substituted for the link path.

## Scan phases

`scan.phase` is exactly one of:

- `scanning` — work is still active.
- `completed` — the requested scope finished.
- `cancelled` — cancellation was requested before completion.
- `failed` — an unexpected scanner error occurred.

`scan.partial` is `true` for `scanning`, `cancelled`, and `failed`; it is `false` only for `completed`.

## Scope and entries

`entries` contains the same measured entries as the TypeScript `ScanSnapshot.items` lists:

- Loose files directly inside a measured root.
- Measured direct subdirectories, with their aggregate logical size.
- It is not a recursive listing of every descendant.

Each entry has:

```json
{
  "displayPath": "C:\\Users\\example\\Downloads\\archive.zip",
  "pathKey": "c:\\users\\example\\downloads\\archive.zip",
  "type": "file",
  "logicalBytes": 1048576,
  "category": "documents"
}
```

`type` is one of `file`, `directory`, `symlink`, `junction`, `reparse`, `unknown`.

Nested roots take precedence:

- A directory that is itself a declared root is excluded from its parent root's scan.
- A directory that is an ancestor of a declared nested root is opened rather than measured as a whole.
- Directory totals must not double-count nested roots.

Symlinks, junctions, and reparse-point directories are not traversed. They contribute their own link metadata size where the scanner can read it and are otherwise reported as inaccessible.

## Logical size

`logicalBytes` is the logical file length reported by `lstat`, not allocated clusters.

- Regular files use their byte length.
- Directories use the sum of measured descendant logical sizes.
- Hard links are counted per path, so logical totals can exceed unique physical storage.
- Sparse files and compressed files use their logical length.
- Zero-byte files contribute zero and are not required to appear in `entries`.

## Volume identity

```json
{
  "id": "\\\\?\\Volume{...}",
  "mount": "C:\\",
  "totalBytes": 510000000000,
  "usedBytes": 469000000000,
  "availableBytes": 40500000000
}
```

The contract compares `id` and `mount` when the same corpus is presented to both scanners. Capacity fields are read-only filesystem accounting.

## Errors and exclusions

`errors` is a stable list of paths the scanner could not read or intentionally skipped:

```json
{
  "displayPath": "C:\\System Volume Information",
  "pathKey": "c:\\system volume information",
  "kind": "unreadable"
}
```

Current kinds:

- `unreadable` — permission, lock, or missing-path failure reported by the scanner.
- `reparse` — a link or reparse point that was intentionally not traversed.

The TypeScript scanner's `blocked` list has no error code. The normalized contract therefore records the path and the broad `unreadable` kind, not an invented errno.

## Totals

```json
{
  "measuredBytes": 3348,
  "unmeasuredBytes": 102399996652,
  "categoryBytes": {
    "apps": 0,
    "developer": 0,
    "documents": 3348,
    "caches": 0,
    "trash": 0,
    "system": 102399996652
  },
  "fileEntries": 2,
  "directoryEntries": 1,
  "errorCount": 1
}
```

`measuredBytes` is the sum added by measured entries. `unmeasuredBytes` is `max(0, volume.usedBytes - measuredBytes)`.

System accounting rule:

- On `completed`, remaining unmeasured bytes are included in `categoryBytes.system`.
- On `cancelled` or `failed`, unmeasured bytes stay separate and `categoryBytes.system` contains only system data that was actually measured.
- `scanning` snapshots are partial and must not be treated as final.

## Final result

```json
{
  "schemaVersion": "1.0",
  "implementation": {
    "name": "typescript-reference",
    "version": "0.1.0"
  },
  "scan": {
    "phase": "completed",
    "partial": false,
    "error": null
  },
  "volume": {
    "id": "\\\\?\\Volume{...}",
    "mount": "C:\\",
    "totalBytes": 0,
    "usedBytes": 0,
    "availableBytes": 0
  },
  "totals": {
    "measuredBytes": 0,
    "unmeasuredBytes": 0,
    "categoryBytes": {},
    "fileEntries": 0,
    "directoryEntries": 0,
    "errorCount": 0
  },
  "entries": [],
  "errors": []
}
```

## Invariants

1. A `completed` result has finished the requested root scope.
2. A `cancelled` result never becomes `completed`.
3. A `failed` result never becomes successful.
4. `partial` is `true` for every non-completed phase.
5. On cancellation or failure, unmeasured bytes are not moved into System data.
6. `measuredBytes` equals the sum of category totals when categories do not overlap.
7. Directory entries equal the sum of their measured descendants within the declared scope.
8. Nested roots are not double-counted.
9. Symlink, junction, and reparse directories are not followed.
10. Permission and I/O failures are represented in `errors` rather than silently becoming measured bytes.
11. Entry ordering is not part of the contract. Compare sorted `pathKey` values.
12. Differences in timing, traversal order, and implementation metadata are not behavioral differences.
13. `displayPath` is display-only; comparison uses `pathKey`. Case and separator differences that normalize to the same key are not behavioral differences.

## Known TypeScript implementation gaps

These are observed gaps in the reference implementation, not intended new behavior:

- `addFile()` swallows file-level `lstat` failures, so some permission errors can be absent from `blocked`.
- `startScan()` reports a denied nested measurement only when its accessible size is below 1 MiB.
- `startScan()` does not consult `layout.foreign`; it relies primarily on reparse-point handling for mounted-volume boundaries.
- Scanner items do not carry an explicit symlink/junction/reparse type, so the reference report labels entries as file or directory.
- Hard links are measured per path, so logical totals can exceed unique physical storage.

## Reference and differential harness

The TypeScript reference report generator is:

```powershell
bun tools/scanner-reference.ts C:\path\to\corpus > reference.json
```

The comparison harness accepts two normalized reports. It sorts entries and errors by `pathKey`, so traversal order is not compared:

```powershell
node tools/scanner-differential.mjs --reference reference.json --candidate candidate.json
```

A future Rust implementation can emit the same contract and be checked without changing the harness.

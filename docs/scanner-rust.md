# Rust scanner prototype

## Status

This is a standalone read-only Windows x64 prototype. It is not wired into the
TypeScript application and is not the default scanner. The TypeScript scanner
remains the production implementation.

Native enumeration and bounded directory workers are now implemented. The
scan-only path reaches the 2x target on the tested 10,000-file and 100,000-file
workloads. Full pretty report serialization is still expensive, and the
TypeScript integration phase remains intentionally disabled pending IPC/report
optimization and a broader differential corpus.

## Build environment

- Windows 11 x64, build 26300
- Intel Core i7-1255U, 10 cores / 12 logical processors
- SAMSUNG MZVL2512HCJQ-00BL2 NVMe SSD
- Rust: `rustc 1.100.1`, GNU Windows target `x86_64-pc-windows-gnu`
- Rust toolchain installed in a temporary toolchain directory, not in the repo

Build and test commands:

```powershell
cargo build --release
cargo test
```

The binary is `scanner-rust/target/release/fix-storage-scanner-rust.exe`.
`scanner-rust/target/` is ignored by Git.

## Architecture

- `src/main.rs`: standalone CLI, NDJSON protocol, cancellation reader.
- `src/protocol.rs`: versioned request/result types, bounded event writer.
- `src/scanner.rs`: scan state, phases, summaries, event batches.
- `src/traversal.rs`: recursive directory aggregation and boundary filtering.
- `src/metadata.rs`: logical size and file/directory/reparse classification.
- `src/errors.rs`: permission/I/O issue construction.
- `src/windows/enumeration.rs`: read-only filesystem wrappers and extended paths.
- `src/windows/native.rs`: `FindFirstFileExW` / `FindNextFileW` enumeration with
  `FIND_FIRST_EX_LARGE_FETCH`, attributes, sizes, and reparse detection.
- `src/windows/reparse.rs`: reparse attribute and reparse file-type detection.
- `src/windows/paths.rs`: normalized/comparison paths and long-path conversion.
- `src/windows/volume.rs`: request volume validation.

The scanner uses a Windows native enumeration path with a standard-library
fallback. It does not use jwalk or Rayon. Directory workers are implemented with
scoped standard-library threads and a bounded work queue. No filesystem
mutation API is used.

## Protocol

Requests are one JSON line on stdin:

```json
{
  "type": "scan_request",
  "schemaVersion": "1.0",
  "requestId": "request-1",
  "roots": [{ "path": "C:\\corpus", "category": "documents" }],
  "skipPaths": [],
  "foreignPaths": [],
  "volume": {
    "id": "volume-id",
    "mount": "C:\\",
    "totalBytes": 510000000000,
    "usedBytes": 469000000000,
    "availableBytes": 40500000000
  },
  "options": { "batchSize": 200, "threads": 1, "collectEntries": true }
}
```

Cancellation is a second line:

```json
{ "type": "cancel", "schemaVersion": "1.0", "requestId": "request-1" }
```

Events are newline-delimited JSON on stdout: `scan_started`, `progress`,
`entries_batch`, `scan_warning`, `scan_error`, `scan_completed`,
`scan_cancelled`, and `scan_failed`. Entries are emitted in bounded batches.
`collectEntries: false` allows streaming mode to avoid retaining the full entry
list; report mode defaults to true.

The scanner exits with code `3` if cancellation does not finish within five
seconds. An abruptly terminated process must be treated by the caller as an
uncertain failed scan, never as a rollback or success.

`--report` is a standalone reporting mode used only for differential testing.
It reads one request and writes the normalized contract report.

## Rust tests

`cargo test` passes 9 integration tests covering:

- Traversal and directory aggregation.
- Logical file sizes and zero-byte omission.
- Nested-root precedence.
- Skip and foreign boundaries.
- Cancellation and unmeasured separation.
- Missing-root errors.
- Unicode paths.
- Long paths with extended I/O.
- Bounded entry batches and terminal protocol events.
- Junction/reparse classification without traversal.

The native enumeration path is exercised by the integration suite and by the
differential/benchmark harnesses. The permission path is implemented as
read-only I/O error handling. A real ACL-denied fixture was not created because
changing Windows ACLs is outside the prototype's safety boundary.

## Differential results

The normalized contract comparison passed on:

- The project source corpus.
- A fixture containing files, a subdirectory, and Unicode names.
- A fixture containing Unicode names and a directory junction.
- A missing-root fixture that exercises error reporting.

The comparison harness sorts by normalized `pathKey` and ignores traversal
order. The Rust and TypeScript reports agreed on phase, volume, measured and
unmeasured bytes, category totals, entries, and errors for those corpora.

## Performance comparison

Optimized configuration: native `FindFirstFileExW` enumeration, six bounded
directory workers, release Rust. TypeScript was measured with concurrency 1 and
6. Three repetitions were run; the table shows medians in milliseconds.

| Shape | Files | Dirs | TS c1 | TS c6 | Rust | Rust vs TS c6 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| flat-1000 | 1000 | 1 | 97.09 | 93.80 | 62.83 | 1.49x |
| nested-20x20 | 400 | 20 | 68.96 | 34.39 | 83.88 | 0.41x |
| mixed-10x50 | 500 | 10 | 61.26 | 44.57 | 79.26 | 0.56x |
| large-100x100 | 10,000 | 100 | 1,112.11 | 751.06 | 82.31 | 9.12x |

100,000 files in one directory:

- TypeScript concurrency 1: 14,787.56 ms
- TypeScript concurrency 6: 14,851.02 ms
- Rust scan-only summary: 749.11 ms
- Rust full pretty report with all entries: 8,837.48 ms

The scan-only 100,000-file path is approximately 19.8x faster than TypeScript
c6. Full report mode is dominated by serializing 100,000 entries and is not a
2x comparison. The IPC path uses bounded compact batches rather than the pretty
report format.

Small fixtures are dominated by process startup and cache noise. The large
10,000-file workload is the meaningful acceptance result; the 100,000-file
scan-only result is the strongest validation. Full IPC/report overhead remains
a bottleneck.

The small fixtures remain dominated by process startup and cache noise. The
10,000-file result and the 100,000-file scan-only result are the meaningful
large-workload signals; the full report/IPC overhead still needs optimization.

## Memory and concurrency

- The production-shaped directory path uses bounded scoped-thread workers.
- `threads` now controls the number of workers; it is no longer ignored.
- Workers measure independent direct child directories and return results to a
  deterministic aggregation array.
- Protocol streaming mode buffers one entry batch at a time.
- `collectEntries: false` keeps the full entry list out of memory.
- Report mode retains entries because the normalized report requires them.
- No Rust peak-RSS or CPU-time measurement was captured; wall time only.
- Cancellation is cooperative at directory and entry boundaries.
- The IPC cancellation path was exercised against a running child process.
- A five-second watchdog terminates an unresponsive cancelled process.

## Safety

- No deletion, recycle, move, rename, write, create, truncate, permission or
  attribute mutation APIs in `scanner-rust/src`.
- No shell execution in the Rust scanner.
- No content reads or hashing.
- No cleanup mode or Recycle Bin API.
- Reparse entries are reported, not followed.
- Long-path filesystem calls use `\\?\` conversion.
- On cancellation, measured bytes and unmeasured bytes remain separate and no
  completed event is emitted.

## Integration status

No TypeScript adapter was added. The Rust prototype remains isolated under
`scanner-rust/`.

The scan-only path now exceeds the performance target on the large workloads,
but full entry/report serialization is still expensive, and the differential
corpus is not broad enough for production replacement. Linux and macOS remain
on the TypeScript implementation, and TypeScript remains the default on
Windows.

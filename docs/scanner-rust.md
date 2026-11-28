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

### Native enumeration experiment

A direct 10,000-file flat-directory experiment produced:

| Approach | Replicate times |
| --- | --- |
| `std::fs::read_dir` only | 6.92, 8.58, 4.59 ms |
| `read_dir` + entry metadata/file type | 4.88, 3.54, 6.66 ms |
| `FindFirstFileExW` native entries | 20.26, 11.84, 9.34 ms |

The native path was slower in this direct comparison. It also allocated and
retained structured entries while the simpler probes only counted/aggregated,
so this is not a like-for-like API cost comparison. Native enumeration is not
assumed to be universally faster.

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
6. Three repetitions were run; the table shows medians in milliseconds. With
only three repetitions, p95 is not statistically meaningful and was not used
for the acceptance decision.

| Shape | Files | Dirs | TS c1 | TS c6 | Rust | Rust vs TS c6 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| flat-1000 | 1000 | 1 | 97.09 | 93.80 | 62.83 | 1.49x |
| nested-20x20 | 400 | 20 | 68.96 | 34.39 | 83.88 | 0.41x |
| mixed-10x50 | 500 | 10 | 61.26 | 44.57 | 79.26 | 0.56x |
| large-100x100 | 10,000 | 100 | 1,112.11 | 751.06 | 82.31 | 9.12x |

Small fixtures are dominated by process startup and cache noise. The large
10,000-file workload is a meaningful acceptance result; the 100,000-entry IPC
section below covers the larger workload.

### End-to-end, 10,000 files / 100 directories

Three repetitions, median wall times:

| Output path | Median |
| --- | ---: |
| TypeScript complete scan | 706.98 ms |
| TypeScript normalized JSON serialization | 0.11 ms |
| TypeScript CLI text rendering | 0.07 ms |
| Rust scan-only summary report | 26.67 ms |
| Rust full normalized report | 28.49 ms |
| Rust report serialization portion | 1.82 ms |
| Rust through TypeScript NDJSON adapter | 49.41 ms |

Single-observation resource readings from the final repetition:

- Parent TypeScript RSS: 248,795,136 bytes
- Rust peak RSS: 5,246,976 bytes
- Rust CPU: 15.625 ms user + 78.125 ms system
- Parent TypeScript CPU: 813 ms user + 1,515 ms system
- Adapter terminal batch count: 1 (all 100 direct directory entries fit the
  requested 200-entry batch)

The adapter adds process/event overhead over direct report mode, but remains
substantially faster than the complete TypeScript scan in this workload. The
adapter output normalized equal to the TypeScript reference.

The reported 590 MB parent RSS is the combined benchmark process after the
TypeScript scan, 100,000-entry normalization, and a 15.9 MB JSON string. It is
not a Rust-only adapter footprint. The integration adapter currently retains a
partial entry array for progress and the final adapter result for a stable
accounting snapshot; removing that duplicate retention is a future optimization.
Display rows remain bounded by the UI's `MAX_ROWS`; complete accounting is not
truncated.

### 100,000-entry IPC run

Actual Rust child through the TypeScript adapter, batch size 200:

| Metric | Value |
| --- | ---: |
| Entries | 100,000 |
| Batches | 500 |
| Adapter total | 1,037.95 ms |
| `scan_started` to terminal event | 763.31 ms |
| NDJSON parse | 259.75 ms |
| Validation | 3.34 ms |
| Result assembly | 30.39 ms |
| Maximum buffered stdout | 121,770 chars |
| Maximum pending batches | 1 |
| Rust peak RSS | 30,490,624 bytes |
| Rust CPU | 468.75 ms user + 203.125 ms system |
| Rust scan-only summary report | 462.49 ms |
| Rust full report | 2,415.95 ms |
| Rust full-report serialization portion | 1,953.45 ms |
| TypeScript complete scan | 36,274.54 ms |
| TypeScript normalized JSON | 61.61 ms |
| TypeScript CLI text render | 3.52 ms |
| TypeScript JSON size | 15,900,554 bytes |

The adapter produced 100,000 normalized entries with exact TypeScript parity.
The full report is dominated by serialization; the adapter path is materially
faster than the full pretty report.

Cancellation while entry batches were arriving was exercised with 10,000 flat
files, batch size 1. The adapter observed 95 partial entries before cancellation,
resolved as `cancelled`, and measured approximately 3.97 ms from cancellation
request to terminal event.

A slow-consumer backpressure probe used 10,000 files, batch size 1, and a
1 ms synchronous delay for every `entries_batch`. It received 10,000 batches,
kept at most one pending batch, and observed a maximum stdout buffer of 65,884
characters. The pipe blocked the producer rather than allowing unbounded
accumulation.

## Memory and concurrency

- The production-shaped directory path uses bounded scoped-thread workers.
- `threads` now controls the number of workers; it is no longer ignored.
- Workers measure independent direct child directories and return results to a
  deterministic aggregation array.
- Protocol streaming mode buffers one entry batch at a time.
- `collectEntries: false` keeps the full entry list out of memory.
- Report mode retains entries because the normalized report requires them.
- The end-to-end script captured one Rust peak-RSS/CPU observation and parent
  RSS/CPU; it did not compute repeated combined peaks.
- Worker utilization, maximum queue depth, and IPC throughput are not
  instrumented.
- Cancellation is cooperative at directory and entry boundaries.
- The IPC cancellation path was exercised against a running child process.
- A five-second watchdog terminates an unresponsive cancelled process.

## Binary distribution

The current GNU-target release binary is `670,174` bytes with SHA-256:

```text
1E16EF28AE7B22F8188B45BB345007275245B822AE6F74FF3619CDE0C4D6659C
```

Its observable DLL imports are Windows system libraries:

```text
bcryptprimitives.dll
KERNEL32.dll
msvcrt.dll
ntdll.dll
PSAPI.DLL
api-ms-win-core-synch-l1-2-0.dll
```

No MinGW-specific runtime DLL was reported by `llvm-objdump`. The binary has
not been tested on a clean Windows installation without a developer toolchain.

No MSVC-target binary was built in this environment because the MSVC linker and
Visual Studio C++ build tools were unavailable. CI now has a Windows Rust job
that installs the GNU target, runs Rust tests, builds the release executable,
prints its SHA-256, and uploads it as an artifact. No release is published by
this workflow.

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

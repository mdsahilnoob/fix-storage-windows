# Scanner benchmark baseline

Command:

```powershell
bun run bench:scanner
```

Environment:

- Windows 11 x64
- Node/Bun runtime reported by the benchmark: `v24.3.0`
- Filesystem: local NTFS temporary directory
- Scanner: TypeScript reference implementation
- Cache state: first run is cold-ish, second run is warm

The benchmark uses synthetic temporary fixtures and removes them afterward. It does not disable Windows security protections.

| Shape | Cache | Files | Dirs | Logical bytes | Wall ms | CPU ms | Peak RSS | Files/s | Dirs/s | readdir | lstat | statfs |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| flat-300-files | cold | 300 | 1 | 1,228,800 | 37.10 | 31.00 | 203,845,632 | 8,087 | 27 | 2 | 302 | 2 |
| flat-300-files | warm | 300 | 1 | 1,228,800 | 17.64 | 47.00 | 204,619,776 | 17,010 | 57 | 2 | 302 | 2 |
| nested-20x10 | cold | 200 | 20 | 409,600 | 18.81 | 78.00 | 207,413,248 | 10,632 | 1,063 | 21 | 221 | 2 |
| nested-20x10 | warm | 200 | 20 | 409,600 | 16.28 | 46.00 | 208,130,048 | 12,284 | 1,228 | 21 | 221 | 2 |
| mixed-10x20 | cold | 200 | 10 | 1,638,400 | 11.79 | 46.00 | 208,654,336 | 16,967 | 848 | 11 | 211 | 2 |
| mixed-10x20 | warm | 200 | 10 | 1,638,400 | 12.78 | 16.00 | 208,990,208 | 15,651 | 783 | 11 | 211 | 2 |
| cancellation-6x200 | cancel | 1,200 | 6 | 819,200 measured | — | — | — | — | — | — | — | — |

Cancellation: `phase=cancelled`, measured `819,200` bytes, cancellation latency approximately `0.31 ms` from request to resolved scan.

## Notes

- These are small-file microbenchmarks, not a prediction of full-volume scan time.
- Cold/warm labels reflect repeated scans on the same NTFS temporary directory; exact cache behavior varies by machine.
- Peak RSS is sampled during the scan and is not a process-wide allocator high-water mark.
- Metadata counts are observed through wrappers around `readdir`, `lstat`, and `statfs`; they are not OS-level I/O counters.
- CPU and wall times are single-run measurements and should be treated as a baseline rather than a statistically robust comparison.

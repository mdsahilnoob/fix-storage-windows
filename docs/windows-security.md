# Windows v1 security model

## Non-negotiable invariant

fix-storage-windows v1 is **read-only**. It performs storage analysis and presents cleanup recommendations. It never applies a recommendation.

Prohibited in v1 runtime paths:

- permanent deletion;
- Recycle Bin or Trash operations;
- moving or renaming files;
- content, attribute or permission changes;
- registry or policy changes;
- `Remove-Item`, `del`, `rmdir`, `fs.rm`, `fs.unlink`, `rmSync`, `unlinkSync`;
- `IFileOperation.DeleteItem`, `PerformOperations`, `SHEmptyRecycleBin`;
- package-manager or system cleanup commands;
- automatic retries of any mutation.

## Read-only backend

The active backend uses:

- CIM/PowerShell for volume discovery only;
- `du` on Unix-like hosts and a Node walker on Windows for size estimates;
- `lstat`, `readdir`, `stat` and `statfs` for metadata;
- `mdls` on macOS and native Shell Explorer reveal for informational navigation;
- in-memory recommendation generation.

The archived PowerShell/C# Recycle Bin bridge is not imported by v1 runtime paths and is excluded from the published npm package. It must not be reactivated as part of v1.

## Recommendations

A recommendation includes:

- the exact path or paths involved;
- an estimated logical byte size;
- a reason based on category and classification;
- an explicit statement that the application changes nothing.

Recommendations are grouped by temporary files, caches, large files, downloads, logs, development artifacts, possible duplicate groups and Recycle Bin usage. Possible duplicates use name and byte size only; file contents are not read, hashed or compared.

## Protected locations

Protected-path rules remain in force for recommendations. System-managed data, profile roots, volume roots, personal folder roots, Recycle Bin contents, unknown volumes and paths outside measured roots are excluded from actionable suggestion panels or clearly marked as informational.

## Windows-specific checks retained

Recycle Bin reporting is descriptive only. The active runtime contains no recycle preflight and schedules no operation.

## Failure semantics

A scan failure is reported as a read-only error. No cleanup outcome exists in v1, so there is no success, failure or unknown cleanup state. Permission errors leave data untouched.

## Development rule

Any new code importing a mutation API into the v1 runtime is a security regression. Tests must use synthetic in-memory values or already-present read-only fixtures; no cleanup fixtures, no deletion experiments, no Recycle Bin operations.

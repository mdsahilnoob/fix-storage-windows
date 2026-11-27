# Security policy

fix-storage-windows reads storage metadata and can move selected files to the Windows Recycle Bin. Bugs that move the wrong item, bypass confirmation, permanently delete data, empty the Recycle Bin, or change anything in `--dry-run`/`--demo` are security issues.

## Reporting

Do not open a public issue for suspected cleanup-safety vulnerabilities. Use the hosting repository's private security-advisory contact once this port is published, or contact the maintainer privately. Include Windows build, Node.js and PowerShell versions, the command/workflow, volume filesystem, and the path shape involved. Do not include private file contents or unrelated personal paths.

## Security expectations

- Every real cleanup uses `IFileOperation` with forced recycle-on-delete and a sink that aborts non-recycle operations; there is no permanent-delete fallback.
- Protected paths and reparse points are rejected before Shell operations.
- Exact paths, count and estimated size require a second confirmation.
- Preflight failures leave the item untouched and never trigger a different deletion mechanism. A post-delete Shell failure can occur after the operation has already taken effect; those outcomes are reported as unconfirmed/unknown and require manual inspection.
- The app does not elevate, unlock files, change ACLs or empty the Recycle Bin.

The implementation is currently unverified. See `docs/windows-security.md` and the outstanding validation matrix in `WINDOWS.md`.

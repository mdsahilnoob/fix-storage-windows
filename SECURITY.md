# Security policy

fix-storage-windows v1 is a read-only storage analysis and recommendation tool. It reads metadata and reports estimates. It never modifies user files or system state.

## v1 security invariant

The application does not:

- delete or recycle files or directories;
- move or rename files;
- empty Trash or the Recycle Bin;
- modify file contents, attributes or permissions;
- modify registry settings or cleanup policies;
- execute shell commands for cleanup;
- invoke Windows IFileOperation deletion methods;
- call `fs.unlink`, `fs.rm`, `rmdir` or equivalent cleanup APIs;
- run package-manager or system cleanup commands.

There is no hidden cleanup mode or activation flag. Cleanup recommendations are informational and must be acted on, if at all, outside the application.

## Reporting

Report any suspected filesystem modification, hidden destructive feature, protected-path bypass, or misleading cleanup claim as a security issue. Include Windows build, Node.js version, command or workflow, and the path shape involved. Do not include private file contents.

## Supported versions

Only the current v1 source line is supported. The implementation is not runtime-verified and must not be treated as production-ready.

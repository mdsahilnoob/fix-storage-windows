# Windows storage categories

The original nine-category model and display order are retained. Categories describe read-only accounting and review policy; a category name never authorizes deletion.

| Category | Tier | Typical content | v1 recommendation policy |
| --- | --- | --- | --- |
| Apps | Review | Program Files, AppData, Packages, application data, game libraries | Persistent application data is not treated as disposable. Informational only. |
| Developer | Review | Toolchains, SDKs, Docker, caches, dependency folders, build output | Dependencies and managed stores are distinguished from caches. Informational only. |
| Photos | Keep | Personal pictures and photo libraries | Reported as occupied storage; no cleanup recommendation. |
| Videos | Keep | Personal videos and projects | Reported as occupied storage; no cleanup recommendation. |
| Documents | Review | Documents, Desktop, Downloads and other profile/data-drive content | Old downloads may be suggested for user review. No file is changed. |
| Music | Keep | Personal audio storage | Reported as occupied storage; no cleanup recommendation. |
| System data | Keep | Windows, recovery, system files, unreadable data | Never offered for review. |
| Caches | Potential savings | Explicitly named rebuildable caches | Reviewable; estimated opportunity only. |
| Trash / Recycle Bin | Keep | Items already deleted | Reviewable as informational storage only. The app never empties or modifies it. |

## Temporary files

Recognized locations include:

- `%TEMP%`, `%TMP%`, `%LOCALAPPDATA%\Temp`;
- Microsoft Windows `INetCache` and Explorer thumbnail cache;
- DirectX and NVIDIA shader caches;
- named `Cache`, `Code Cache`, `GPUCache`, `DawnCache`, `ShaderCache`, and `ComponentModelCache` children under Local/Roaming AppData;
- packaged-app `LocalCache`, `TempState`, and `AC\INetCache`.

Application state outside these specific roots remains Apps or Developer data. Entire `%APPDATA%`, `%LOCALAPPDATA%`, or `Packages` folders are never considered disposable.

## Developer storage

Possible review candidates include `node_modules`, JavaScript build caches, pip/Poetry caches, Cargo, Go build cache, Gradle, Maven, NuGet, Composer, Visual Studio caches and VS Code data. Dependencies are distinguished from caches. Project source, lockfiles and configuration are never cleanup candidates.

Docker storage is application-managed data and is not generic junk.

## Gaming storage

Steam, Epic, Xbox, Riot and other common launchers are recognized. Shader caches and temporary downloads may be identified for review; installations, saves and user-created content are never junk.

## Duplicate candidates

Possible duplicate files are grouped by exact byte size and matching name. File contents are not read, hashed or compared. The user must compare candidates outside the application.

## Accounting caveats

Logical file lengths are used. NTFS allocated size, compression, sparse ranges, alternate streams and hard-link deduplication are not represented. Moved-to-Recycle-Bin accounting does not exist in v1. Reports show estimated category sizes and estimated cleanup opportunities, never reclaimed space.

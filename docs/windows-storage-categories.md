# Windows storage categories

The original nine-category model and display order are retained. Categories describe accounting and review policy; a category name alone never authorizes deletion.

| Category | Tier on Windows | Typical content | Cleanup policy |
| --- | --- | --- | --- |
| Apps | Review | Program Files, AppData, Packages, application data, game libraries | Installed/persistent data is not bulk-cleaned. Explicit eligible descendants can only be recycled; program trees are protected. |
| Developer | Review | Toolchains, SDKs, Docker, `.cargo`, `.rustup`, Go, Gradle, Maven, NuGet, editors | Dependencies and managed stores are distinguished from caches. Docker and package stores are not generic junk. |
| Photos | Keep | Standard Pictures folder and recognized photo folders on data drives | Personal content; root protected. |
| Videos | Keep | Standard Videos folder, recordings and captures | Personal content; root protected. |
| Documents | Review | Documents, Desktop, Downloads, other profile/data-drive content | Never automatically cleared. Explicit eligible selection uses the Recycle Bin. |
| Music | Keep | Standard Music folder and recognized audio folders | Personal content; root protected. |
| System data | Keep | Windows, recovery, system files, unreadable/unmeasured space | Never offered for cleanup. Labels suggest Windows/app management where appropriate. |
| Caches | Safe to review | Current-user Temp and explicitly named rebuildable caches | Direct-child plan, exact review and second confirmation, then Recycle Bin only. |
| Recycle Bin | Keep | Per-volume `$Recycle.Bin` accounting | Never emptied or moved again by this app. |

“Junk” is a conservative UI classification, not a permanent-delete flag. On Windows even junk-labelled caches use the Recycle Bin.

## Temporary and application caches

Recognized locations include:

- `%TEMP%`, `%TMP%`, `%LOCALAPPDATA%\Temp`;
- Microsoft Windows INetCache and Explorer thumbnail cache;
- DirectX and NVIDIA shader caches;
- named `Cache`, `Code Cache`, `GPUCache`, `DawnCache`, `ShaderCache`, and `ComponentModelCache` children directly under Local/Roaming AppData;
- packaged-app `LocalCache`, `TempState`, and `AC\INetCache`;
- npm, pnpm cache, Yarn, Bun, pip, Poetry, Cargo downloaded registry cache, Go build, Gradle, NuGet HTTP/plugin, and Composer caches.

Application state outside these specific roots remains Apps or Developer data. Entire `%APPDATA%`, `%LOCALAPPDATA%`, or `Packages` folders are never considered disposable. Windows Temp and Windows Update servicing directories are not enabled as native bulk-cleanup roots.

## Developer dependencies and stores

The scanner recognizes common locations for:

- `node_modules` and JavaScript build caches;
- npm/pnpm/Yarn/Bun storage;
- pip/Poetry and Python environments;
- Cargo/Rustup;
- Go modules and build cache;
- Gradle and Maven;
- NuGet packages and HTTP caches;
- Composer;
- Docker and WSL-related Docker data;
- Visual Studio, VS Code, Cursor and Android tooling.

`node_modules` can be labelled rebuildable, while package-manager stores such as pnpm store, NuGet packages, Maven repository, Go module cache and Cargo registry sources are labelled managed stores. Build output is reviewable, not a bulk cache root. Source code, repositories, lockfiles and configuration are not automatically selected.

Docker images, volumes, settings and disks are application-managed data. Use Docker's own inspection/prune workflows rather than treating its directory as junk.

## Gaming storage

Steam/Epic/Xbox/Riot and other common top-level game folders are recognized on data drives, along with standard Steam shader caches and temporary downloads.

- **Shader caches:** rebuildable and labelled junk where specifically recognized.
- **Temporary launcher downloads:** reviewable, not automatically deleted.
- **Game installations:** managed content; uninstall/move through the launcher.
- **Saves and user-created content:** personal data, not junk.
- **Entire libraries:** never classified as a cleanup category.

## Classification and metadata

Windows paths are normalized to forward slashes and lowercase for path-sensitive rules. Modification time is displayed as `modified`, not `last opened`. NTFS last-access time is not used because it may be disabled, delayed, or affected by scanning. Old modification time alone does not make a Windows item `unused` or recommend deletion.

## Accounting caveats

Logical file lengths are used. NTFS allocated size, compression, sparse ranges, alternate streams and hard-link deduplication are not currently represented. Symbolic links and junctions are not traversed; other reparse-point configurations still need validation, though selected cleanup paths are checked natively for `FILE_ATTRIBUTE_REPARSE_POINT`. Moved-to-Recycle-Bin bytes are reported separately from actually reclaimed bytes. As a result, category totals are estimates and can differ from Explorer; independently measured overlapping content can exceed filesystem usage, while unreadable content appears in System data.

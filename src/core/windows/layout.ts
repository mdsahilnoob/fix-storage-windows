import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Root } from "../categories";
import type { Drive } from "../drives";
import type { Layout } from "../layout";
import { extendedPath, insidePath, normalPath, samePath, windowsEntryKind } from "./paths";

const CACHE_NAMES = new Set(["cache", "code cache", "gpucache", "dawncache", "shadercache", "componentmodelcache"]);
const GAME_FOLDERS = /^(steam|steamlibrary|epic games|epicgames|xbox|xboxgames|riot games|riot client|gog games|ea games|battle\.net)$/i;
const MEDIA_FOLDERS: Array<[RegExp, Root["category"]]> = [
  [/^(pictures|photos|images|screenshots|dcim)$/i, "photos"],
  [/^(videos|movies|recordings|captures)$/i, "movies"],
  [/^(music|audio|songs|podcasts)$/i, "music"],
  [GAME_FOLDERS, "apps"],
];

function root(path: string, category: Root["category"], hidden?: Root["hidden"]): Root {
  return hidden ? { path, category, hidden } : { path, category };
}

function onDrive(path: string, drive: Drive): boolean {
  return drive.mounts.some((mount) => samePath(path, mount.point) || insidePath(path, mount.point));
}

async function directories(path: string): Promise<string[]> {
  if ((await windowsEntryKind(path)) !== "directory") return [];
  try {
    return (await fsp.readdir(extendedPath(path), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => join(path, entry.name));
  } catch {
    return [];
  }
}

/** Adds only explicitly named cache folders, never an app's whole data directory. */
async function namedCaches(roots: Root[], parent: string, names = CACHE_NAMES): Promise<void> {
  for (const path of await directories(parent)) {
    const name = path.slice(parent.length + 1).toLowerCase();
    if (names.has(name)) roots.push(root(path, "caches"));
  }
}

async function applicationCaches(roots: Root[], local: string, roaming: string): Promise<void> {
  await namedCaches(roots, local);
  await namedCaches(roots, roaming);
  const packages = join(local, "Packages");
  for (const packageRoot of await directories(packages)) {
    for (const name of ["LocalCache", "TempState"]) {
      roots.push(root(join(packageRoot, name), "caches"));
    }
    await namedCaches(roots, join(packageRoot, "AC"), new Set(["INetCache"]));
  }
}

function homeRoots(home: string): Root[] {
  const local = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
  const roaming = process.env.APPDATA || join(home, "AppData", "Roaming");
  const temp = process.env.TEMP || process.env.TMP || join(local, "Temp");
  const h = (...parts: string[]) => join(home, ...parts);
  const roots: Root[] = [
    root(join(local, "Temp"), "caches"),
    root(temp, "caches"),
    root(join(local, "Microsoft", "Windows", "INetCache"), "caches"),
    root(join(local, "Microsoft", "Windows", "Explorer"), "caches"),
    root(join(local, "D3DSCache"), "caches"),
    root(join(local, "NVIDIA", "DXCache"), "caches"),
    root(join(local, "NVIDIA", "GLCache"), "caches"),
    root(join(local, "npm-cache"), "caches"),
    root(join(roaming, "npm-cache"), "caches"),
    root(join(local, "pnpm", "cache"), "caches"),
    root(join(local, "Yarn", "Cache"), "caches"),
    root(h(".yarn", "berry", "cache"), "caches"),
    root(h(".bun", "install", "cache"), "caches"),
    root(join(local, "pip", "Cache"), "caches"),
    root(join(local, "pypoetry", "Cache"), "caches"),
    root(h(".cargo", "registry", "cache"), "caches"),
    root(join(local, "go-build"), "caches"),
    root(h(".gradle", "caches"), "caches"),
    root(join(local, "NuGet", "v3-cache"), "caches"),
    root(join(local, "NuGet", "plugins-cache"), "caches"),
    root(join(local, "Composer", "cache"), "caches"),
    root(join(roaming, "Composer", "cache"), "caches"),

    root(join(local, "pnpm", "store"), "developer"),
    root(h(".cargo"), "developer"),
    root(h(".rustup"), "developer"),
    root(h("go"), "developer"),
    root(h(".gradle"), "developer"),
    root(h(".m2"), "developer"),
    root(h(".nuget"), "developer"),
    root(h(".dotnet"), "developer"),
    root(h(".docker"), "developer"),
    root(h(".bun"), "developer"),
    root(h(".deno"), "developer"),
    root(h(".vscode"), "developer"),
    root(h(".cursor"), "developer"),
    root(h(".android"), "developer"),
    root(join(local, "Docker"), "developer"),
    root(join(roaming, "Docker"), "developer"),
    root(join(local, "Programs"), "apps"),
    root(join(local, "Microsoft", "VisualStudio"), "developer"),
    root(join(local, "Microsoft", "VSCode"), "apps"),
    root(join(roaming, "Code"), "apps"),

    root(join(local, "Packages"), "apps"),
    root(local, "apps"),
    root(roaming, "apps"),
    root(h("AppData", "LocalLow"), "apps"),

    root(h("Pictures"), "photos"),
    root(h("Videos"), "movies"),
    root(h("Documents"), "documents"),
    root(h("Desktop"), "documents"),
    root(h("Downloads"), "documents"),
    root(h("Music"), "music"),
    root(home, "documents", "developer"),
  ];
  return roots;
}

function systemRoots(drive: Drive): Root[] {
  const top = drive.mount;
  const windows = process.env.SystemRoot || join(top, "Windows");
  const programFiles = process.env.ProgramFiles || join(top, "Program Files");
  const programFilesX86 = process.env["ProgramFiles(x86)"] || join(top, "Program Files (x86)");
  const programData = process.env.ProgramData || join(top, "ProgramData");
  return [
    root(windows, "system"),
    root(join(top, "pagefile.sys"), "system"),
    root(join(top, "hiberfil.sys"), "system"),
    root(join(top, "swapfile.sys"), "system"),
    root(join(top, "System Volume Information"), "system"),
    root(join(top, "Recovery"), "system"),
    root(join(top, "$WinREAgent"), "system"),
    root(join(top, "$Windows.~BT"), "system"),
    root(join(top, "$Windows.~WS"), "system"),
    root(join(top, "Windows.old"), "system"),
    root(programFiles, "apps"),
    root(programFilesX86, "apps"),
    root(programData, "apps"),
  ];
}

/** Windows roots are user/profile-aware on the home drive and generic on data drives. */
export async function windowsLayout(drive: Drive, home = homedir()): Promise<Layout> {
  if (drive.kind === "boot") {
    return {
      drive,
      home,
      roots: [root(drive.mount, "system")],
      lookOnly: "boot or recovery volume, look only · removing files here can stop Windows from starting",
      foreign: () => true,
      skip: () => false,
      canonical: (path) => path,
    };
  }
  const roots: Root[] = [];
  const ownsHome = onDrive(home, drive);
  if (drive.system) roots.push(...systemRoots(drive));
  if (ownsHome) {
    roots.push(...homeRoots(home));
    const local = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    const roaming = process.env.APPDATA || join(home, "AppData", "Roaming");
    await applicationCaches(roots, local, roaming);
  }

  // A non-system drive is measured in full. Specific nested roots below take
  // precedence during traversal, so media and game folders are not double-counted.
  if (!drive.system) roots.push(root(drive.mount, "documents", "developer"));
  for (const path of await directories(drive.mount)) {
    const name = path.slice(drive.mount.length + 1);
    const match = MEDIA_FOLDERS.find(([pattern]) => pattern.test(name));
    if (match) roots.push(root(path, match[1]));
    if (GAME_FOLDERS.test(name)) {
      roots.push(root(join(path, "steamapps", "shadercache"), "caches"));
      roots.push(root(join(path, "ShaderCache"), "caches"));
    }
  }
  roots.push(root(join(drive.mount, "$Recycle.Bin"), "trash"));

  const unique = new Map<string, Root>();
  for (const item of roots) {
    if (!onDrive(item.path, drive)) continue;
    const key = normalPath(item.path);
    unique.delete(key);
    unique.set(key, item);
  }

  const ownPoints = new Set(drive.mounts.map((mount) => normalPath(mount.point)));
  const foreign = (path: string) => {
    // NTFS volume mount points are reparse points and the scanner will not
    // traverse them. Own alternate mount names are aliases, not extra drives.
    return !onDrive(path, drive) && !ownPoints.has(normalPath(path));
  };
  return {
    drive,
    home,
    roots: [...unique.values()],
    lookOnly: drive.readOnly ? "this volume is read-only" : null,
    foreign,
    skip: (path) => drive.mounts.some((mount) => samePath(path, mount.point) && !samePath(path, drive.mount)),
    canonical: (path) => path,
  };
}

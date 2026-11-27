import { homedir } from "node:os";
import { CATEGORIES, type CategoryId } from "./categories";
import type { Clearable } from "./clean";
import { MAC_DRIVE, type Drive, type DriveKind } from "./drives";
import { LOOK_ONLY, type Layout } from "./layout";
import { IS_MAC, IS_WINDOWS } from "./platform";
import { emptySnapshot, type Item, type ScanHandle, type ScanSnapshot } from "./scan";

/** Made-up disks, for trying the interface without touching the real ones. */
const GB = 1e9;

interface DemoDisk {
  total: number;
  sizes: Record<CategoryId, number>;
  paths: Record<CategoryId, string[]>;
}

const MAC: DemoDisk = {
  total: 512 * GB,
  sizes: {
    apps: 52.6 * GB,
    developer: 36.3 * GB,
    photos: 58.6 * GB,
    movies: 44.1 * GB,
    documents: 41.7 * GB,
    music: 12.1 * GB,
    system: 34.2 * GB,
    caches: 46.8 * GB,
    trash: 31.4 * GB,
  },
  paths: {
    apps: ["/Applications/Xcode.app", "/Applications/Penrose Studio.app", "/Applications/Figma.app"],
    developer: ["~/Library/Developer/CoreSimulator", "~/.rustup/toolchains", "/opt/homebrew/Cellar"],
    photos: ["~/Pictures/Photos Library.photoslibrary"],
    movies: ["~/Movies/Final Cut Projects", "~/Movies/Screen Recordings"],
    documents: ["~/Documents/Archive", "~/Downloads/installers", "~/Desktop/old-projects"],
    music: ["~/Music/Music/Media.localized", "~/Music/Logic"],
    system: ["/System/Volumes/Data/.snapshots", "/private/var/vm", "/private/var/log"],
    caches: [
      "~/Library/Caches/pnpm",
      "~/Library/Caches/Homebrew",
      "~/Library/Developer/Xcode/DerivedData/Atlas-bfkqz",
      "~/Library/Caches/com.spotify.client",
      "~/.npm/_cacache",
      "~/Library/Caches/Google",
      "~/.cache/huggingface",
      "~/Library/Caches/com.apple.dt.Xcode",
    ],
    trash: [
      "~/.Trash/Old exports",
      "~/.Trash/atlas-backup.zip",
      "~/.Trash/Screen Recording 2025-03-02.mov",
      "~/.Trash/node_modules",
      "~/.Trash/Untitled.fcpbundle",
      "~/.Trash/Installers",
    ],
  },
};

const LINUX: DemoDisk = {
  total: 1000 * GB,
  sizes: {
    apps: 88.4 * GB,
    developer: 61.2 * GB,
    photos: 48.9 * GB,
    movies: 72.5 * GB,
    documents: 57.3 * GB,
    music: 14.6 * GB,
    system: 41.8 * GB,
    caches: 53.1 * GB,
    trash: 22.7 * GB,
  },
  paths: {
    apps: ["~/.local/share/Steam", "/var/lib/flatpak/app", "/opt/google", "~/.var/app/com.discordapp.Discord"],
    developer: ["~/.rustup/toolchains", "~/.ollama/models", "/var/lib/docker", "~/.local/share/containers"],
    photos: ["~/Pictures/darktable", "~/Pictures/2024"],
    movies: ["~/Videos/obs", "~/Videos/kdenlive"],
    documents: ["~/Projects/atlas", "~/Downloads/installers", "~/Desktop/old-projects", "~/Downloads/ubuntu-24.04.iso"],
    music: ["~/Music/library", "~/Music/ardour"],
    system: ["/usr/lib", "/var/cache/pacman", "/var/log/journal", "/usr/share", "/swapfile"],
    caches: [
      "~/.cache/huggingface",
      "~/.cache/yay",
      "~/.cache/pip",
      "~/.npm/_cacache",
      "~/.cache/mozilla",
      "~/.cache/thumbnails",
      "~/.cache/go-build",
      "~/.cache/JetBrains",
    ],
    trash: [
      "~/.local/share/Trash/files/Old exports",
      "~/.local/share/Trash/files/atlas-backup.zip",
      "~/.local/share/Trash/files/recording.mkv",
      "~/.local/share/Trash/files/node_modules",
      "~/.local/share/Trash/files/Installers",
    ],
  },
};

const GAMES: DemoDisk = {
  total: 2000 * GB,
  sizes: { apps: 1184 * GB, developer: 0, photos: 0, movies: 286 * GB, documents: 141 * GB, music: 0, system: 0.4 * GB, caches: 0, trash: 18.2 * GB },
  paths: {
    apps: ["/mnt/games/SteamLibrary/steamapps/common", "/mnt/games/SteamLibrary/steamapps/shadercache", "/mnt/games/Heroic"],
    developer: [],
    photos: [],
    movies: ["/mnt/games/Videos/recordings", "/mnt/games/Videos/clips"],
    documents: ["/mnt/games/backups", "/mnt/games/isos", "/mnt/games/Windows.iso"],
    music: [],
    system: [],
    caches: [],
    trash: ["/mnt/games/.Trash-1000/files/old-saves", "/mnt/games/.Trash-1000/files/mods.zip"],
  },
};

const WINDOWS: DemoDisk = {
  total: 533 * GB,
  sizes: { apps: 96.2 * GB, developer: 4.1 * GB, photos: 6.3 * GB, movies: 11.8 * GB, documents: 64.7 * GB, music: 2.2 * GB, system: 58.9 * GB, caches: 9.4 * GB, trash: 7.6 * GB },
  paths: {
    apps: ["/mnt/windows/Program Files", "/mnt/windows/Program Files (x86)", "/mnt/windows/Users/you/AppData/Local"],
    developer: ["/mnt/windows/Users/you/.cargo"],
    photos: ["/mnt/windows/Users/you/Pictures"],
    movies: ["/mnt/windows/Users/you/Videos/Captures"],
    documents: ["/mnt/windows/Windows.old", "/mnt/windows/Users/you/Downloads", "/mnt/windows/Users/you/Documents"],
    music: ["/mnt/windows/Users/you/Music"],
    system: ["/mnt/windows/Windows", "/mnt/windows/hiberfil.sys", "/mnt/windows/pagefile.sys", "/mnt/windows/System Volume Information"],
    caches: ["/mnt/windows/Users/you/AppData/Local/Temp", "/mnt/windows/Windows/SoftwareDistribution/Download"],
    trash: ["/mnt/windows/$Recycle.Bin"],
  },
};

const NATIVE_WINDOWS: DemoDisk = {
  ...WINDOWS,
  paths: {
    apps: ["C:\\Program Files", "C:\\Program Files (x86)", "C:\\Users\\you\\AppData\\Local", "C:\\SteamLibrary\\steamapps\\common"],
    developer: ["C:\\Users\\you\\.cargo", "C:\\Users\\you\\.gradle", "C:\\Users\\you\\AppData\\Local\\Docker"],
    photos: ["C:\\Users\\you\\Pictures"],
    movies: ["C:\\Users\\you\\Videos\\Captures"],
    documents: ["C:\\Users\\you\\Downloads", "C:\\Users\\you\\Documents", "C:\\Users\\you\\Desktop\\old-projects"],
    music: ["C:\\Users\\you\\Music"],
    system: ["C:\\Windows", "C:\\hiberfil.sys", "C:\\pagefile.sys", "C:\\System Volume Information"],
    caches: ["C:\\Users\\you\\AppData\\Local\\Temp", "C:\\Users\\you\\AppData\\Local\\npm-cache", "C:\\SteamLibrary\\steamapps\\shadercache"],
    trash: ["C:\\$Recycle.Bin"],
  },
};

const DISKS: Record<string, DemoDisk> = { [MAC_DRIVE.id]: MAC, "demo-main": LINUX, "demo-games": GAMES, "demo-windows": WINDOWS, "demo-windows-native": NATIVE_WINDOWS };
const disk = (layout: Layout) => DISKS[layout.drive.id] ?? (IS_MAC ? MAC : IS_WINDOWS ? NATIVE_WINDOWS : LINUX);

/** A demo drive's size and use, as --drives shows them. */
export function demoSpace(drive: Drive): { total: number; used: number; available: number } {
  const { total, sizes } = DISKS[drive.id] ?? (IS_MAC ? MAC : IS_WINDOWS ? NATIVE_WINDOWS : LINUX);
  const used = Object.values(sizes).reduce((a, b) => a + b, 0);
  return { total, used, available: total - used };
}

function demoDrive(id: string, name: string, mount: string, kind: DriveKind, fstype: string, label: string): Drive {
  return { id, name, mount, mounts: [], device: `/dev/demo-${label}`, fstype, label, readOnly: false, kind, home: kind === "main", system: kind === "main" };
}

/** The demo's drives: one on a Mac, three on Linux so the drive switcher has something to switch. */
export function demoDrives(): Drive[] {
  if (IS_MAC) return [MAC_DRIVE];
  if (IS_WINDOWS) {
    return [{
      id: "demo-windows-native",
      name: "C: Demo SSD",
      mount: "C:\\",
      mounts: [],
      device: "\\\\?\\Volume{demo}",
      fstype: "NTFS",
      label: "Demo SSD",
      readOnly: false,
      kind: "main",
      home: true,
      system: true,
      driveType: "fixed",
    }];
  }
  return [
    demoDrive("demo-main", "/", "/", "main", "ext4", "root"),
    demoDrive("demo-games", "/mnt/games", "/mnt/games", "data", "ext4", "games"),
    demoDrive("demo-windows", "Windows", "/mnt/windows", "windows", "ntfs", "Windows"),
  ];
}

export function demoLayout(drive: Drive): Layout {
  const lookOnly = !IS_WINDOWS && drive.kind === "windows" ? LOOK_ONLY.windows : null;
  return { drive, home: homedir(), roots: [], lookOnly, foreign: () => false, skip: () => false, canonical: (path) => path };
}

/** Splits a size across paths in decreasing shares. */
function split(total: number, paths: string[]): Item[] {
  const weights = paths.map((_, i) => 1 / (i + 1.4));
  const sum = weights.reduce((a, b) => a + b, 0);
  return paths.map((path, i) => ({ path, size: (total * weights[i]) / sum, dir: !/\.(zip|mov|mkv|dmg|pkg|iso|sys)$/i.test(path) && !/\/swapfile$/.test(path) }));
}

export function demoPlan(category: Clearable, layout: Layout): Item[] {
  const { sizes, paths } = disk(layout);
  const items = split(sizes[category], paths[category]);
  // Many small steps so the clearing animation has something to show.
  return items.flatMap((item) =>
    Array.from({ length: 6 }, (_, i) => ({ path: i === 0 ? item.path : `${item.path}/${i}`, size: item.size / 6 })),
  );
}

export function startDemoScan(layout: Layout, onUpdate: (snapshot: ScanSnapshot) => void): ScanHandle {
  const { sizes, paths } = disk(layout);
  const snap = { ...emptySnapshot(), ...demoSpace(layout.drive) };
  let timer: NodeJS.Timeout | null = null;

  const done = new Promise<ScanSnapshot>((resolve) => {
    const steps = CATEGORIES.flatMap((category) => {
      if (category.id === "system" || paths[category.id].length === 0) return [];
      const parts = 14;
      return Array.from({ length: parts }, (_, i) => ({
        id: category.id,
        bytes: sizes[category.id] / parts,
        path: paths[category.id][i % paths[category.id].length],
      }));
    });
    let index = 0;
    timer = setInterval(() => {
      const step = steps[index++];
      if (step) {
        snap.sizes[step.id] += step.bytes;
        snap.measured += step.bytes;
        snap.current = step.path;
        onUpdate({ ...snap, sizes: { ...snap.sizes } });
        return;
      }
      if (timer) clearInterval(timer);
      snap.sizes = { ...sizes };
      snap.measured = snap.used;
      for (const category of CATEGORIES) snap.items[category.id] = split(sizes[category.id], paths[category.id]);
      snap.current = "";
      snap.phase = "done";
      onUpdate({ ...snap, sizes: { ...snap.sizes } });
      resolve(snap);
    }, 35);
  });

  return {
    cancel() {
      if (timer) clearInterval(timer);
    },
    done,
  };
}

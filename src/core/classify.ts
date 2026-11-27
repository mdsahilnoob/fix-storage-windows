import { basename, extname } from "node:path";
import type { CategoryId } from "./categories";
import { IS_MAC, IS_WINDOWS } from "./platform";
import type { Item } from "./scan";

/**
 * Informational verdicts used for read-only recommendations:
 * junk:   likely regenerates by itself or is a leftover.
 * unused: possibly not needed any more; your call to review.
 * yours:  your data, shown for context only.
 * system: managed by the OS or another tool; not a review candidate.
 */
export type Verdict = "junk" | "unused" | "yours" | "system";

export interface Usage {
  /** Milliseconds since epoch. */
  at: number;
  /** "opened" when a last-opened date is known, "changed" when only the modification time is. */
  kind: "opened" | "changed";
}

export interface Label {
  verdict: Verdict;
  /** Short, lowercase reason, e.g. "rebuildable with npm install". */
  reason: string;
}

const DAY = 24 * 3600 * 1000;

/**
 * Folders that are one thing as far as the user is concerned: a culprit search
 * stops at them instead of digging into their internals.
 */
export function isWhole(path: string): boolean {
  const name = basename(path).toLowerCase();
  return (
    name === "node_modules" ||
    name === "windowsapps" ||
    BUILD_CACHES.has(name) ||
    (IS_WINDOWS && /[\\/](steamapps[\\/]common|\.vs)$/i.test(path)) ||
    /\.(app|framework|photoslibrary|fcpbundle|logicx|imovielibrary|bundle|vmwarevm|pvm|utm|sparsebundle|xcarchive)$/.test(name)
  );
}

/** "3 days", "7 months", "2 years". */
export function age(ms: number): string {
  const days = Math.max(0, Math.floor(ms / DAY));
  if (days < 1) return "today";
  if (days < 30) return `${days} ${days === 1 ? "day" : "days"}`;
  const months = Math.floor(days / 30.4);
  if (months < 12) return `${months} ${months === 1 ? "month" : "months"}`;
  const years = Math.floor(days / 365);
  return `${years} ${years === 1 ? "year" : "years"}`;
}

/** "today", "3 days ago". */
export function ago(ms: number): string {
  const text = age(ms);
  return text === "today" ? "today" : `${text} ago`;
}

/** Compact age for a column: "3d", "7mo", "2y". */
export function shortAge(ms: number): string {
  const days = Math.max(0, Math.floor(ms / DAY));
  if (days < 1) return "today";
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30.4)}mo`;
  return `${Math.floor(days / 365)}y`;
}

const BUILD_CACHES = new Set([
  ".next",
  ".nuxt",
  ".turbo",
  ".parcel-cache",
  ".svelte-kit",
  ".angular",
  ".expo",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".gradle",
  ".dart_tool",
]);
const INSTALLERS = new Set([".dmg", ".pkg", ".mpkg", ".iso", ".xip", ".deb", ".rpm", ".msi"]);
const ARCHIVES = new Set([".zip", ".tar", ".gz", ".tgz", ".rar", ".7z", ".bz2", ".xz"]);
const SCREEN_CAPTURE = /^(screen recording|screenshot|cleanshot|screen shot|recording)\b/i;

function idle(usage: Usage | undefined, now: number): number | null {
  return usage ? now - usage.at : null;
}

/** Informational notes about system-managed storage; v1 performs no action. */
const SYSTEM_REASONS: Array<[RegExp, string]> = [
  [/^\/var\/cache\/pacman(\/|$)/, "package-manager downloads · managed by pacman"],
  [/^\/var\/cache\/apt(\/|$)/, "package-manager downloads · managed by apt"],
  [/^\/var\/cache\/(dnf|libdnf5|yum)(\/|$)/, "package-manager downloads · managed by dnf"],
  [/^\/var\/cache\/zypp(\/|$)/, "package-manager downloads · managed by zypper"],
  [/^\/var\/log\/journal(\/|$)/, "systemd journal · managed by the system"],
  [/^\/var\/log(\/|$)/, "system logs"],
  [/^\/var\/lib\/systemd\/coredump(\/|$)/, "crash dumps · managed by systemd"],
  [/^\/var\/tmp(\/|$)/, "temporary system files"],
  [/^\/var\/cache(\/|$)/, "system caches"],
  [/^\/usr(\/|$)/, "installed packages · managed by the package system"],
  [/^\/nix(\/|$)/, "package store · managed by Nix"],
  [/^\/boot(\/|$)/, "kernels and boot files · changing them can prevent startup"],
  [/^\/(swapfile|swap)(\/|$)|\/swap(file)?(\.img)?$/i, "swap file · used by the system as extra memory"],
  [/^\/(\.snapshots|timeshift)(\/|$)/, "snapshots · managed by snapshot tooling"],
  [/^\/etc(\/|$)/, "system settings"],
  [/\/hiberfil\.sys$/i, "hibernation file · managed by Windows power settings"],
  [/\/pagefile\.sys$/i, "Windows page file · sized by Windows"],
  [/\/swapfile\.sys$/i, "Windows swap file"],
  [/\/System Volume Information(\/|$)/, "restore points · managed by Windows System Protection"],
  [/\/Windows\/WinSxS(\/|$)/, "Windows component store · managed by Windows servicing"],
  [/\/\$Windows\.~(BT|WS)(\/|$)/, "Windows upgrade remnants · managed by Windows setup"],
  [/\/(Windows|Recovery|\$WinREAgent)(\/|$)/, "Windows system files"],
  [/\/EFI\/Microsoft(\/|$)/, "Windows boot loader · changing it can prevent startup"],
  [/\/EFI(\/|$)/, "boot loaders · changing them can prevent startup"],
];

function systemReason(path: string): string {
  if (IS_WINDOWS) {
    if (/\/windows\/winsxs(\/|$)/.test(path)) return "Windows component store · managed by Windows servicing";
    if (/\/windows\/softwaredistribution(\/|$)/.test(path)) return "Windows update data · managed by Windows Update";
    if (/\/windows(\/|$)/.test(path)) return "Windows system files · managed by Windows";
    if (/\/\$windows\.~(bt|ws)(\/|$)/.test(path)) return "Windows upgrade remnants · managed by Windows setup";
  }
  for (const [pattern, reason] of SYSTEM_REASONS) if (pattern.test(path)) return reason;
  return IS_MAC ? "managed by macOS" : IS_WINDOWS ? "managed by Windows" : "managed by the system";
}

/** Decides what an item probably is, from its name, where it lives, and when it was last used. */
export function classify(item: Item, category: CategoryId, usage?: Usage, now: number = Date.now()): Label {
  const path = IS_WINDOWS ? item.path.replace(/\\/g, "/").toLowerCase() : item.path;
  const name = basename(item.path);
  const lower = name.toLowerCase();
  const ext = extname(lower);
  const since = idle(usage, now);
  const untouched =
    since !== null && usage && since > 30 * DAY ? ` · ${usage.kind === "opened" ? "not opened" : "not touched"} in ${age(since)}` : "";

  if (category === "system") return { verdict: "system", reason: systemReason(path) };
  if (category === "trash") return { verdict: "junk", reason: "already in the trash" };
  if (/\/softwaredistribution\/download/i.test(path))
    return { verdict: "junk", reason: "Windows update downloads · managed by Windows Update" };
  if (category === "caches") return { verdict: "junk", reason: "cache · apps rebuild it when they need it" };

  // Windows application, package and game data is not interchangeable with a cache.
  if (IS_WINDOWS) {
    if (/\/(program files( \(x86\))?|programdata)(\/|$)/.test(path))
      return { verdict: "system", reason: "installed or persistent application data · managed by its application" };
    if (/\/(docker|com\.docker\.docker)(\/|$)/.test(path))
      return { verdict: "system", reason: "Docker storage · managed by Docker" };
    if (/\/(pnpm\/store|\.nuget\/packages|\.m2\/repository|go\/pkg\/mod|\.cargo\/registry\/src)(\/|$)/.test(path))
      return { verdict: "system", reason: "package manager store · managed by its package manager" };
    if (/\/steamapps\/shadercache(\/|$)/.test(path) || /\/(shadercache|d3dscache)(\/|$)/.test(path))
      return { verdict: "junk", reason: "shader cache · the game or graphics driver rebuilds it" };
    if (/\/steamapps\/(downloading|temp)(\/|$)/.test(path))
      return { verdict: "unused", reason: "temporary launcher download · review it in the launcher" };
    if (/\/(savegames|saved games|saves)(\/|$)/.test(path)) return { verdict: "yours", reason: "game saves or user-created content" };
    if (/\/(steamapps\/common|xboxgames|epic games|riot games)(\/|$)/.test(path))
      return { verdict: "system", reason: "game installation · managed by its launcher" };
  }

  // Things that rebuild themselves.
  if (lower === "node_modules") return { verdict: "junk", reason: `rebuildable with npm install${untouched}` };
  if (BUILD_CACHES.has(lower)) return { verdict: "junk", reason: `build cache · rebuilds itself${untouched}` };
  if (lower === "pods" && item.dir) return { verdict: "junk", reason: `rebuildable with pod install${untouched}` };
  if (path.includes("/Xcode/DerivedData")) return { verdict: "junk", reason: "Xcode build products · rebuilt by the next build" };
  if (path.includes("/iOS DeviceSupport/") || path.includes("/watchOS DeviceSupport/"))
    return { verdict: "junk", reason: "device debug symbols · managed by Xcode" };
  if (path.includes("/CoreSimulator/Caches")) return { verdict: "junk", reason: "simulator cache" };
  if (/\/steamapps\/shadercache(\/|$)/.test(path)) return { verdict: "junk", reason: "shader cache · rebuilt by Steam" };
  if (/\/\.var\/app\/[^/]+\/cache$/.test(path)) return { verdict: "junk", reason: "flatpak app cache · the app rebuilds it" };

  // Installers and leftovers.
  if (INSTALLERS.has(ext)) return { verdict: "junk", reason: `installer file · not needed after installation${untouched}` };

  // Probably not needed, but yours to decide.
  if ((lower === "target" || lower === "dist" || lower === "build" || lower === "out") && item.dir && path.includes("/"))
    return { verdict: "unused", reason: `build output · rebuildable from source${untouched}` };
  if ((lower === ".venv" || lower === "venv" || lower === "env") && item.dir)
    return { verdict: "unused", reason: `Python environment · rebuildable from dependencies${untouched}` };
  if (path.includes("/CoreSimulator/Devices/")) return { verdict: "unused", reason: `simulator device${untouched}` };
  if (path.includes("/Xcode/Archives/")) return { verdict: "unused", reason: `old app archive${untouched}` };
  if (path.includes("/MobileSync/Backup/")) return { verdict: "unused", reason: `iphone or ipad backup${untouched}` };
  if (ARCHIVES.has(ext) && (IS_WINDOWS ? path.includes("/downloads/") : path.includes("/Downloads/"))) return { verdict: "unused", reason: `downloaded archive${untouched}` };
  if (SCREEN_CAPTURE.test(name) && since !== null && since > 14 * DAY)
    return { verdict: "unused", reason: `screen capture from ${ago(since)}` };
  if (lower === "windows.old" && item.dir)
    return { verdict: "unused", reason: "previous Windows installation · managed by Windows setup" };

  // Storage owned by another tool; reported as system-managed.
  if (lower === "docker.raw" || path.includes("/com.docker.docker/"))
    return { verdict: "system", reason: "Docker storage · managed by Docker" };
  if (path.includes("/.ollama/models")) return { verdict: "system", reason: "local AI models · managed by Ollama" };
  if (path.startsWith("/opt/homebrew") || path.startsWith("/usr/local/Cellar") || path.startsWith("/home/linuxbrew/"))
    return { verdict: "system", reason: "Homebrew-managed storage" };
  if (/^\/var\/lib\/docker(\/|$)|\/\.local\/share\/docker(\/|$)/.test(path))
    return { verdict: "system", reason: "Docker images and volumes · managed by Docker" };
  if (/^\/var\/lib\/containers(\/|$)|\/\.local\/share\/containers(\/|$)/.test(path))
    return { verdict: "system", reason: "Podman images · managed by Podman" };
  if (/^\/var\/lib\/flatpak(\/|$)|\/\.local\/share\/flatpak(\/|$)/.test(path))
    return { verdict: "system", reason: "Flatpak-managed storage" };
  if (/^\/var\/lib\/snapd(\/|$)/.test(path))
    return { verdict: "system", reason: "Snap-managed storage" };
  if (/^\/var\/lib\/libvirt(\/|$)/.test(path))
    return { verdict: "system", reason: "virtual machines · managed by virtualization tooling" };
  if (!IS_MAC && /^\/(opt|usr\/local)(\/|$)/.test(path))
    return { verdict: "system", reason: "installed software · managed by the package manager" };

  // Windows modification time is not last-used evidence and never by itself
  // makes an item a deletion recommendation.
  if (IS_WINDOWS && since !== null && usage) return { verdict: "yours", reason: `modified ${ago(since)}` };

  // Nothing about the name says junk; fall back to how long it has sat there.
  if (since !== null && usage) {
    const verb = usage.kind === "opened" ? "not opened" : "not touched";
    if (since > 365 * DAY) return { verdict: "unused", reason: `${verb} in ${age(since)}` };
    if (since > 180 * DAY && (ext === ".app" || category === "movies" || (!IS_WINDOWS && path.includes("/Downloads/"))))
      return { verdict: "unused", reason: `${verb} in ${age(since)}` };
    return { verdict: "yours", reason: `${usage.kind} ${ago(since)}` };
  }
  return { verdict: "yours", reason: "" };
}

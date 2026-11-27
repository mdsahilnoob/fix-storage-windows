import { promises as fsp } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Layout } from "../layout";
import { atOrInside, driveRoot, extendedPath, insidePath, isDriveRoot, normalPath, samePath } from "./paths";

function protectedTrees(layout: Layout): string[] {
  // A folder-mounted volume has its own root at drive.mount, not at the
  // containing drive's letter. Protect both it and the running Windows volume.
  const tops = [layout.drive.mount, driveRoot(layout.drive.mount)];
  return tops.flatMap((top) => [
    join(top, "Windows"),
    join(top, "Program Files"),
    join(top, "Program Files (x86)"),
    join(top, "ProgramData"),
    join(top, "Boot"),
    join(top, "Recovery"),
    join(top, "System Volume Information"),
    join(top, "$Recycle.Bin"),
  ]).concat([
    process.env.SystemRoot || join(driveRoot(layout.drive.mount), "Windows"),
    process.env.ProgramFiles || join(driveRoot(layout.drive.mount), "Program Files"),
    process.env["ProgramFiles(x86)"] || join(driveRoot(layout.drive.mount), "Program Files (x86)"),
    process.env.ProgramData || join(driveRoot(layout.drive.mount), "ProgramData"),
  ]);
}

function protectedRoots(layout: Layout): string[] {
  const home = layout.home;
  return [
    ...layout.roots.map((item) => item.path),
    ...layout.drive.mounts.map((mount) => mount.point),
    driveRoot(layout.drive.mount),
    home,
    join(home, "Documents"),
    join(home, "Desktop"),
    join(home, "Pictures"),
    join(home, "Videos"),
    join(home, "Music"),
    join(home, "Downloads"),
    join(home, "AppData"),
    join(home, "AppData", "Local"),
    join(home, "AppData", "Roaming"),
    join(home, "AppData", "LocalLow"),
  ];
}

/** Central Windows removal policy, used by both item and category cleanup. */
export function cannotRemoveWindows(path: string, layout: Layout): string | null {
  if (!isAbsolute(path)) return "Not an absolute Windows path.";
  if (layout.lookOnly) return layout.lookOnly;
  const driveType = layout.drive.driveType?.toLowerCase();
  if (!driveType || !["fixed", "removable"].includes(driveType)) {
    return "The Recycle Bin is not verified for this volume type; cleanup is disabled here.";
  }
  const target = resolve(path);
  if (isDriveRoot(target)) return "A volume root cannot be moved to the Recycle Bin.";
  if (protectedTrees(layout).some((folder) => atOrInside(target, folder))) {
    return "Windows, installed applications, or the Recycle Bin manages this location.";
  }
  if (protectedRoots(layout).some((folder) => samePath(target, folder))) {
    return "This is a protected profile, personal, or measured root folder.";
  }

  // Protect every user-profile root, not only the signed-in user's profile.
  const userRoots = [layout.drive.mount, driveRoot(layout.drive.mount)].map((top) => join(top, "Users"));
  if (userRoots.some((users) => insidePath(target, users) && !relative(users, target).includes(sep))) return "A user profile root is protected.";
  if (layout.foreign(target)) return "This location belongs to another volume.";
  if (!layout.roots.some((item) => insidePath(target, item.path))) return "Outside the folders this tool measures.";
  return null;
}

function onSelectedMount(canonical: string, layout: Layout): string {
  if (!layout.drive.device) return canonical;
  const device = normalPath(layout.drive.device);
  const real = normalPath(canonical);
  if (!device || (real !== device && !real.startsWith(device + "\\"))) return canonical;
  const suffix = real === device ? "" : real.slice(device.length);
  return layout.drive.mount + suffix;
}

/** Last-line defense immediately before Shell recycling. */
export async function validateWindowsRecycle(path: string, layout: Layout): Promise<void> {
  const reason = cannotRemoveWindows(path, layout);
  if (reason) throw new Error(reason);
  let stat;
  try {
    stat = await fsp.lstat(extendedPath(path));
  } catch (error) {
    throw new Error(`Cannot access ${path}: ${(error as Error).message}`);
  }
  if (stat.isSymbolicLink()) throw new Error("Junctions and symbolic links are not cleanup candidates; the item was left untouched.");
  let canonical: string;
  try {
    canonical = await fsp.realpath(extendedPath(path));
  } catch (error) {
    throw new Error(`Cannot resolve ${path} safely: ${(error as Error).message}`);
  }
  const mountedCanonical = onSelectedMount(canonical, layout);
  if (normalPath(mountedCanonical) !== normalPath(path)) {
    throw new Error("The path resolves through a junction, symbolic link, SUBST drive, or alias; it was left untouched.");
  }
  const canonicalReason = cannotRemoveWindows(mountedCanonical, layout);
  if (canonicalReason) throw new Error(canonicalReason);
}

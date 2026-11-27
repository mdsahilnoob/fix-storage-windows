import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Layout } from "../layout";
import { atOrInside, driveRoot, insidePath, isDriveRoot, samePath } from "./paths";

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

/** Windows read-only review restriction: why a path must stay informational. */
export function windowsReviewRestriction(path: string, layout: Layout): string | null {
  if (!isAbsolute(path)) return "Not an absolute Windows path.";
  if (layout.lookOnly) return layout.lookOnly;
  const driveType = layout.drive.driveType?.toLowerCase();
  if (!driveType || !["fixed", "removable"].includes(driveType)) {
    return "The Recycle Bin is not verified for this volume type; this location remains informational.";
  }
  const target = resolve(path);
  if (isDriveRoot(target)) return "A volume root is not a review candidate.";
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

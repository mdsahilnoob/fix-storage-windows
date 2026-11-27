import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { mountOf, readMounts } from "./drives";
import { homeTrash } from "./layout";

/**
 * The freedesktop.org trash, the one GNOME, KDE and every other Linux desktop
 * share, so anything moved here can be put back from the file manager.
 * https://specifications.freedesktop.org/trash-spec/latest/
 */

const uid = typeof process.getuid === "function" ? process.getuid() : 0;

/** Device of a path, or of its nearest folder that exists. */
async function deviceOf(path: string): Promise<number | null> {
  let current = path;
  for (;;) {
    try {
      return (await fsp.stat(current)).dev;
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/** The trash at the top of another drive: $top/.Trash/$uid when an admin set one up, else $top/.Trash-$uid. */
async function topTrash(top: string): Promise<string> {
  const shared = join(top, ".Trash");
  try {
    const stat = await fsp.lstat(shared);
    // Only a real folder with the sticky bit is trusted; anything else is ignored.
    if (stat.isDirectory() && (stat.mode & 0o1000) !== 0) {
      const mine = join(shared, String(uid));
      await fsp.mkdir(mine, { recursive: true, mode: 0o700 });
      return mine;
    }
  } catch {
    // no shared trash
  }
  const own = join(top, `.Trash-${uid}`);
  try {
    await fsp.mkdir(own, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error(`no trash this account can use on ${top}`);
  }
  const stat = await fsp.lstat(own);
  if (!stat.isDirectory() || stat.uid !== uid) throw new Error(`${own} is not a trash folder this account owns`);
  return own;
}

/** Percent-encodes a path the way .trashinfo files expect, keeping the slashes. */
const encode = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** Local time as YYYY-MM-DDThh:mm:ss. */
function stamp(date: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}` +
    `T${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
  );
}

/** Moves a file or folder to the trash of the drive it is on and returns where it went. */
export async function trashLinux(path: string, home: string = homedir()): Promise<string> {
  const target = resolve(path);
  const stat = await fsp.lstat(target);
  const mine = homeTrash(home);

  let trash: string;
  let top: string | null = null;
  if (stat.dev === (await deviceOf(mine))) {
    trash = mine;
  } else {
    top = mountOf(target, readMounts())?.point ?? null;
    if (!top) throw new Error("could not tell which drive this is on");
    trash = await topTrash(top);
  }

  const files = join(trash, "files");
  const info = join(trash, "info");
  await fsp.mkdir(files, { recursive: true, mode: 0o700 });
  await fsp.mkdir(info, { recursive: true, mode: 0o700 });

  // On another drive's trash the path is stored relative to that drive's top.
  const original = top ? relative(top, target) : target;
  const body = `[Trash Info]\nPath=${encode(original)}\nDeletionDate=${stamp(new Date())}\n`;
  const name = basename(target);
  const ext = stat.isDirectory() ? "" : extname(name);
  const stem = name.slice(0, name.length - ext.length);

  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? name : `${stem}.${n}${ext}`;
    const infoPath = join(info, `${candidate}.trashinfo`);
    // Claiming the .trashinfo name first is what keeps two programs from picking the same name.
    let handle;
    try {
      handle = await fsp.open(infoPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    try {
      await handle.writeFile(body);
    } finally {
      await handle.close();
    }
    const dest = join(files, candidate);
    try {
      await fsp.lstat(dest);
      // A leftover without its .trashinfo: pick another name.
      await fsp.unlink(infoPath);
      continue;
    } catch {
      // free
    }
    try {
      await fsp.rename(target, dest);
    } catch (error) {
      await fsp.unlink(infoPath).catch(() => {});
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EXDEV") throw new Error("the trash for this drive is on another filesystem");
      throw error;
    }
    return dest;
  }
  throw new Error("the trash has no free name for this");
}

/** After something in a trash's files/ folder is deleted for good, its .trashinfo goes too. */
export async function forgetTrashInfo(path: string): Promise<void> {
  const files = dirname(path);
  if (basename(files) !== "files" || !/^(Trash|\.Trash-\d+|\d+)$/.test(basename(dirname(files)))) return;
  await fsp.unlink(join(dirname(files), "info", `${basename(path)}.trashinfo`)).catch(() => {});
}

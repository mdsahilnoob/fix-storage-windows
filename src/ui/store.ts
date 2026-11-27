import { basename } from "node:path";
import { CATEGORIES, CATEGORY, CLEARABLE, type CategoryId } from "../core/categories";
import { classify, type Label, type Usage } from "../core/classify";
import {
  cannotRemove,
  demoCulprit,
  demoUsage,
  findCulprit,
  forgetAllSizes,
  forgetSizes,
  usage as lookUpUsage,
  type Culprit,
  deleteForGood,
  deletesForGood,
  demoChildren,
  listFolder,
  moveToTrash,
  reveal,
  trashPathFor,
  type ListHandle,
} from "../core/browse";
import { clean, plan, type Clearable } from "../core/clean";
import { demoDrives, demoLayout, demoPlan, startDemoScan } from "../core/demo";
import { listDrives, pickDrive, type Drive, type Partition } from "../core/drives";
import { size, tilde } from "../core/format";
import { layoutFor, type Layout } from "../core/layout";
import { FILE_MANAGER, IS_MAC, IS_WINDOWS, OS_NAME, TRASH_NAME } from "../core/platform";
import { normalPath } from "../core/windows/paths";
import { diskSpace, emptySnapshot, measure, startScan, unmeasuredBytes, type Item, type ScanHandle, type ScanSnapshot } from "../core/scan";

export interface Action {
  id: Clearable;
  /** Path being removed right now. */
  current: string;
}

/** Which side of the screen the arrow keys move in. */
export type Pane = "sidebar" | "list";

/** A folder opened inside the detail pane. */
export interface Level {
  path: string;
  size: number;
}

export interface AppState {
  /** Mounted drives; one on a Mac. */
  drives: Drive[];
  /** Index of the drive on screen. */
  drive: number;
  /** How the drive on screen is measured; null while it is being worked out. */
  layout: Layout | null;
  /** Partitions with files on them that are not mounted. */
  unmounted: Partition[];
  scan: ScanSnapshot;
  /** Category shown in the detail pane. */
  selected: CategoryId;
  /** Category under the pointer in the bar or sidebar. */
  hover: CategoryId | null;
  pane: Pane;
  /** Highlighted row in the detail list. */
  row: number;
  /** Folders opened below the category, outermost first. */
  stack: Level[];
  /** Contents of the innermost opened folder. */
  children: Item[];
  /** True while the opened folder is still being measured. */
  listing: boolean;
  /** Category-wide clearing in progress. */
  action: Action | null;
  /** What is waiting for a second press: a category to clear, or one item to remove. */
  confirm:
    | { kind: "category"; id: Clearable; paths?: string[]; bytes?: number; items?: Item[] }
    | { kind: "item"; path: string; paths?: string[]; bytes?: number }
    | null;
  /** Item being moved or deleted right now. */
  removing: string | null;
  /** Bytes actually reclaimed since the app started, from fresh disk measurements. */
  freed: number;
  /** Estimated logical bytes moved to the Recycle Bin; no space reclaimed yet. */
  movedToRecycleBinBytes: number;
  /** One line about the last action, shown until the next one. */
  note: string | null;
  /** When each listed item was last opened or changed, by path. */
  usage: Record<string, Usage>;
  /** Where the space inside each folder is, by path; "pending" while it is being measured. */
  culprits: Record<string, Culprit | "pending">;
  /** Show only things labelled junk or unused. */
  junkOnly: boolean;
}

export interface Options {
  demo: boolean;
  dryRun: boolean;
  /** Drive to open first: a number, name, mount point or any path on it. */
  drive?: string;
}

type Listener = () => void;

/** Sizes below this are not worth a suggestion. */
const WORTH_CLEARING = 50e6;
/** Longest list the detail pane draws. */
export const MAX_ROWS = 150;

function descendant(path: string, parent: string): boolean {
  if (IS_WINDOWS) return normalPath(path).startsWith(normalPath(parent) + "\\");
  return path.startsWith(parent + "/");
}

export class Store {
  private state: AppState = {
    drives: [],
    drive: 0,
    layout: null,
    unmounted: [],
    scan: emptySnapshot(),
    selected: CATEGORIES[0].id,
    hover: null,
    pane: "sidebar",
    row: 0,
    stack: [],
    children: [],
    listing: false,
    action: null,
    confirm: null,
    removing: null,
    freed: 0,
    movedToRecycleBinBytes: 0,
    note: null,
    usage: {},
    culprits: {},
    junkOnly: false,
  };
  private listeners = new Set<Listener>();
  private scanHandle: ScanHandle | null = null;
  private listHandle: ListHandle | null = null;
  private confirmTimer: NodeJS.Timeout | null = null;
  private culpritHandle: ListHandle | null = null;
  private culpritQueue: Item[] = [];
  private usagePending = new Set<string>();
  private enrichScheduled = false;
  /** Finished scans by drive, so switching back to a drive is instant. */
  private scans = new Map<string, ScanSnapshot>();
  /** Bumped on every drive load, so a slow one that was overtaken is dropped. */
  private loads = 0;
  private confirmationPlans = 0;

  constructor(readonly options: Options) {}

  get = (): AppState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<AppState>) {
    const before = this.state;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
    if (
      before.selected !== this.state.selected ||
      before.stack !== this.state.stack ||
      before.children !== this.state.children ||
      before.row !== this.state.row ||
      before.scan.phase !== this.state.scan.phase ||
      before.junkOnly !== this.state.junkOnly
    ) {
      this.scheduleEnrich();
    }
  }

  // ---- labels, last-used dates and culprits ---------------------------------

  /** What an item probably is, and why. */
  label(item: Item, state: AppState = this.state): Label {
    return classify(item, state.selected, state.usage[item.path]);
  }

  toggleJunkOnly() {
    this.clearConfirm();
    this.set({ junkOnly: !this.state.junkOnly, row: 0 });
  }

  /** Fetches dates and culprits for whatever just came on screen, once things settle. */
  private scheduleEnrich() {
    if (this.enrichScheduled) return;
    this.enrichScheduled = true;
    setTimeout(() => {
      this.enrichScheduled = false;
      this.enrich();
    }, 120);
  }

  private enrich() {
    const { scan, listing, row } = this.state;
    if (scan.phase !== "done" && this.state.stack.length === 0) return;
    const all = this.allEntries().slice(0, MAX_ROWS);

    // Last-used dates for every visible row.
    const missing = all.map((i) => i.path).filter((p) => !(p in this.state.usage) && !this.usagePending.has(p));
    if (missing.length > 0) {
      if (this.options.demo) {
        const usage = { ...this.state.usage };
        for (const p of missing) usage[p] = demoUsage(p);
        this.set({ usage });
      } else {
        for (const p of missing) this.usagePending.add(p);
        void lookUpUsage(missing).then((found) => {
          for (const p of missing) this.usagePending.delete(p);
          this.set({ usage: { ...this.state.usage, ...Object.fromEntries(found) } });
        });
      }
    }

    // Culprits: the highlighted folder first, then the biggest few on screen.
    if (listing) return;
    const entries = this.entries();
    const wanted = [entries[row], ...entries.filter((i) => i.dir).slice(0, 4)].filter(
      (i): i is Item => !!i && !!i.dir && !(i.path in this.state.culprits),
    );
    const seen = new Set<string>();
    this.culpritQueue = wanted.filter((i) => (seen.has(i.path) ? false : (seen.add(i.path), true)));
    this.nextCulprit();
  }

  private nextCulprit(): void {
    if (this.culpritHandle) return;
    const item = this.culpritQueue.shift();
    if (!item) return;
    if (item.path in this.state.culprits) return this.nextCulprit();
    this.set({ culprits: { ...this.state.culprits, [item.path]: "pending" } });
    const finish = (culprit: Culprit) => {
      this.culpritHandle = null;
      this.set({ culprits: { ...this.state.culprits, [item.path]: culprit } });
      this.nextCulprit();
    };
    if (this.options.demo) {
      const category = this.state.selected;
      const depth = this.state.stack.length + 1;
      const timer = setTimeout(() => finish(demoCulprit(category, item.path, item.size, depth)), 350);
      this.culpritHandle = { cancel: () => clearTimeout(timer) };
      return;
    }
    this.culpritHandle = findCulprit(item.path, finish);
  }

  /** Stops measuring culprits that are no longer on screen. */
  private dropCulpritWork() {
    this.culpritQueue = [];
    if (this.culpritHandle) {
      this.culpritHandle.cancel();
      this.culpritHandle = null;
      const culprits = { ...this.state.culprits };
      for (const [path, value] of Object.entries(culprits)) if (value === "pending") delete culprits[path];
      this.state = { ...this.state, culprits };
    }
  }

  /** Opens every folder on the way to the highlighted folder's culprit and lands on it. */
  goToCulprit(row = this.state.row) {
    const item = this.entries()[row];
    const culprit = item ? this.state.culprits[item.path] : undefined;
    if (!item || !culprit || culprit === "pending" || culprit.chain.length === 0 || this.state.removing) return;
    this.listHandle?.cancel();
    this.dropCulpritWork();
    this.clearConfirm();
    const path = [item, ...culprit.chain];
    const last = path[path.length - 1];
    // Land in the folder that holds the culprit, with the culprit highlighted.
    const target = path[path.length - 2];
    const above = path.slice(0, path.length - 2).map((i) => ({ path: i.path, size: i.size }));
    this.set({ stack: [...this.state.stack, ...above] });
    this.openItem(target, last.path);
  }

  /** True when nothing is deleted for real. */
  get pretend(): boolean {
    return this.options.demo || this.options.dryRun;
  }

  // ---- scanning ------------------------------------------------------------

  /** Lists the drives again and measures the one on screen from scratch. */
  rescan() {
    if (this.state.action || this.state.removing) return;
    this.stopWork();
    forgetAllSizes();
    this.scans.clear();
    this.set({ scan: emptySnapshot(), note: null, stack: [], children: [], listing: false, row: 0, culprits: {} });
    const current = this.state.drives[this.state.drive];
    void this.load(async () => {
      const { drives, unmounted } = this.options.demo ? { drives: demoDrives(), unmounted: [] } : await listDrives();
      const keep = current ? drives.findIndex((d) => d.id === current.id) : -1;
      const asked = pickDrive(this.options.drive, drives);
      const note = this.options.drive && !asked && !current ? `No drive matches ${this.options.drive}.` : this.state.note;
      this.set({ drives, unmounted, drive: keep >= 0 ? keep : Math.max(0, drives.indexOf(asked ?? drives[0])), note });
    });
  }

  private stopWork() {
    this.scanHandle?.cancel();
    this.scanHandle = null;
    this.listHandle?.cancel();
    this.clearConfirm();
    this.dropCulpritWork();
  }

  /** Works out the drive's layout, then shows its last scan or measures it. */
  private async load(before?: () => Promise<void>) {
    const ticket = ++this.loads;
    this.set({ layout: null });
    try {
      await before?.();
    } catch (error) {
      if (ticket === this.loads) {
        this.set({
          drives: [],
          scan: { ...emptySnapshot(), phase: "done" },
          note: `Could not discover Windows volumes: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }
    try {
      const drive = this.state.drives[this.state.drive];
      if (ticket !== this.loads) return;
      if (!drive) {
        this.set({ scan: { ...emptySnapshot(), phase: "done" }, note: "No accessible Windows volumes were found." });
        return;
      }
      const layout = this.options.demo ? demoLayout(drive) : await layoutFor(drive);
      if (ticket !== this.loads) return;
      this.set({ layout });
      const cached = this.scans.get(drive.id);
      if (cached) {
        this.set({ scan: cached });
        return;
      }
      const start = this.options.demo ? startDemoScan : startScan;
      const handle = start(layout, (scan) => {
        if (this.scanHandle !== handle) return;
        if (scan.phase === "done") this.scans.set(drive.id, scan);
        this.set({ scan });
      });
      this.scanHandle = handle;
    } catch (error) {
      if (ticket === this.loads) {
        this.set({
          layout: null,
          scan: { ...emptySnapshot(), phase: "done" },
          note: `Could not inspect this volume: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  /** Shows another drive: by index, or relative to this one with step. */
  setDrive(index: number) {
    const { drives, drive, action, removing } = this.state;
    if (action || removing || drives.length < 2) return;
    const next = ((index % drives.length) + drives.length) % drives.length;
    if (next === drive) return;
    // Keep what the current drive's scan knows, deletions included.
    if (this.state.scan.phase === "done") this.scans.set(drives[drive].id, this.state.scan);
    this.stopWork();
    this.set({ drive: next, scan: emptySnapshot(), note: null, stack: [], children: [], listing: false, row: 0, pane: "sidebar" });
    void this.load();
  }

  nextDrive(step = 1) {
    this.setDrive(this.state.drive + step);
  }

  // ---- moving around -------------------------------------------------------

  setHover(hover: CategoryId | null) {
    if (hover !== this.state.hover) this.set({ hover });
  }

  /** Shows a category in the detail pane, back at its top level. */
  select(id: CategoryId, pane: Pane = this.state.pane) {
    if (id === this.state.selected && this.state.stack.length === 0) {
      if (pane !== this.state.pane) this.set({ pane });
      return;
    }
    this.listHandle?.cancel();
    this.dropCulpritWork();
    this.clearConfirm();
    this.set({ selected: id, stack: [], children: [], listing: false, row: 0, pane });
  }

  moveCategory(delta: number) {
    const index = CATEGORIES.findIndex((c) => c.id === this.state.selected);
    const next = CATEGORIES[Math.max(0, Math.min(CATEGORIES.length - 1, index + delta))];
    this.select(next.id, "sidebar");
  }

  setPane(pane: Pane) {
    if (pane === "list" && this.entries().length === 0) return;
    if (pane !== this.state.pane) this.set({ pane });
  }

  /** What the detail pane lists right now. */
  entries(state: AppState = this.state): Item[] {
    const list = this.allEntries(state);
    return list.length > MAX_ROWS ? list.slice(0, MAX_ROWS) : list;
  }

  /** Every entry, including those past the drawing limit. */
  allEntries(state: AppState = this.state): Item[] {
    const list = state.stack.length === 0 ? state.scan.items[state.selected] : state.children;
    if (!state.junkOnly) return list;
    return list.filter((item) => {
      const { verdict } = this.label(item, state);
      return verdict === "junk" || verdict === "unused";
    });
  }

  /** Bytes in the current list labelled junk, and labelled unused. */
  reclaimable(state: AppState = this.state): { junk: number; unused: number } {
    const list = state.stack.length === 0 ? state.scan.items[state.selected] : state.children;
    let junk = 0;
    let unused = 0;
    for (const item of list) {
      const { verdict } = this.label(item, state);
      if (verdict === "junk") junk += item.size;
      else if (verdict === "unused") unused += item.size;
    }
    return { junk, unused };
  }

  /** Size of whatever the detail pane is looking at. */
  scopeSize(state: AppState = this.state): number {
    const top = state.stack[state.stack.length - 1];
    return top ? top.size : state.scan.sizes[state.selected];
  }

  moveRow(delta: number) {
    const count = this.entries().length;
    if (count === 0) return;
    const row = Math.max(0, Math.min(count - 1, this.state.row + delta));
    if (row !== this.state.row) {
      this.clearConfirm();
      this.set({ row });
    }
  }

  setRow(row: number) {
    if (row !== this.state.row) this.clearConfirm();
    this.set({ row, pane: "list" });
  }

  /** Opens the highlighted folder and measures what is inside. */
  open(row = this.state.row) {
    const item = this.entries()[row];
    if (!item || !item.dir || this.state.removing) return;
    this.listHandle?.cancel();
    this.dropCulpritWork();
    this.clearConfirm();
    const stack = [...this.state.stack, { path: item.path, size: item.size }];

    if (this.options.demo) {
      this.set({
        stack,
        children: demoChildren(this.state.selected, item.path, item.size, stack.length),
        listing: false,
        row: 0,
        pane: "list",
        note: null,
      });
      return;
    }

    this.set({ stack, children: [], listing: true, row: 0, pane: "list", note: null });
    const handle = listFolder(
      item.path,
      (children, done) => {
        if (this.listHandle !== handle) return;
        this.set({ children, listing: !done });
      },
      this.state.layout?.foreign,
    );
    this.listHandle = handle;
  }

  /** Goes up one folder; from the category's top level, back to the sidebar. */
  back() {
    this.clearConfirm();
    const { stack } = this.state;
    if (stack.length === 0) {
      this.set({ pane: "sidebar" });
      return;
    }
    this.listHandle?.cancel();
    this.dropCulpritWork();
    const left = stack[stack.length - 1];
    const rest = stack.slice(0, -1);
    if (rest.length === 0) {
      const row = Math.max(0, this.state.scan.items[this.state.selected].findIndex((i) => i.path === left.path));
      this.set({ stack: [], children: [], listing: false, row });
      return;
    }
    // Measure the parent again and land on the folder we just left.
    const parent = rest[rest.length - 1];
    this.set({ stack: rest.slice(0, -1) });
    this.openItem({ path: parent.path, size: parent.size, dir: true }, left.path);
  }

  /** Opens a folder that is not necessarily in the current list. */
  private openItem(item: Item, highlight?: string) {
    const stack = [...this.state.stack, { path: item.path, size: item.size }];
    const pick = (children: Item[]) => Math.max(0, children.findIndex((c) => c.path === highlight));
    if (this.options.demo) {
      const children = demoChildren(this.state.selected, item.path, item.size, stack.length);
      this.set({ stack, children, listing: false, row: pick(children), pane: "list" });
      return;
    }
    this.set({ stack, children: [], listing: true, row: 0, pane: "list" });
    const handle = listFolder(
      item.path,
      (children, done) => {
        if (this.listHandle !== handle) return;
        this.set({ children, listing: !done, row: done ? pick(children) : this.state.row });
      },
      this.state.layout?.foreign,
    );
    this.listHandle = handle;
  }

  /** Jumps back to a level in the breadcrumb: -1 is the category itself. */
  jump(level: number) {
    const { stack } = this.state;
    if (level >= stack.length - 1) return;
    this.listHandle?.cancel();
    this.dropCulpritWork();
    this.clearConfirm();
    if (level < 0) {
      this.set({ stack: [], children: [], listing: false, row: 0 });
      return;
    }
    const target = stack[level];
    this.set({ stack: stack.slice(0, level) });
    this.openItem({ path: target.path, size: target.size, dir: true });
  }

  // ---- acting on items -----------------------------------------------------

  /** Why the highlighted item cannot be removed, or null. */
  blocked(item: Item | undefined): string | null {
    if (!item) return "Nothing selected.";
    const { layout, selected } = this.state;
    if (!layout) return "Still working out this drive.";
    if (layout.lookOnly) return layout.lookOnly.charAt(0).toUpperCase() + layout.lookOnly.slice(1) + ".";
    if (selected === "system") return IS_MAC ? "macOS manages System data." : `${OS_NAME} manages System data · the label says how to shrink it.`;
    if (IS_WINDOWS && selected === "trash") return "Windows manages the Recycle Bin. This app never empties it.";
    if (this.options.demo) return null;
    return cannotRemove(item.path, layout);
  }

  async reveal(row = this.state.row) {
    const item = this.entries()[row];
    if (!item) return;
    if (this.options.demo) {
      this.set({ note: `Demo: would show ${tilde(item.path)} in ${FILE_MANAGER}.` });
      return;
    }
    try {
      await reveal(item.path);
      this.set({ note: `Showing ${basename(item.path)} in ${FILE_MANAGER}.` });
    } catch {
      this.set({ note: `Could not show ${tilde(item.path)} in ${FILE_MANAGER}.` });
    }
  }

  /** First press arms, second press within a few seconds removes. */
  removeItem(row = this.state.row) {
    const { state } = this;
    if (state.action || state.removing || state.scan.phase !== "done") return;
    const item = this.entries()[row];
    const reason = this.blocked(item);
    if (reason) {
      this.set({ note: reason });
      return;
    }
    if (state.confirm?.kind === "item" && state.confirm.path === item.path) {
      this.clearConfirm();
      void this.runRemove(item);
      return;
    }
    this.arm({ kind: "item", path: item.path, paths: [item.path], bytes: item.size });
    if (row !== state.row) this.set({ row, pane: "list" });
  }

  private async runRemove(item: Item) {
    const category = this.state.selected;
    const layout = this.state.layout;
    if (!layout) return;
    const forGood = deletesForGood(category);
    this.set({ removing: item.path, note: null });

    let ok = true;
    let error = "";
    let trashed = trashPathFor(item.path, layout);
    if (this.pretend) {
      await new Promise((done) => setTimeout(done, 450));
    } else {
      try {
        if (forGood) await deleteForGood(item.path, category);
        else trashed = await moveToTrash(item.path, layout);
      } catch (e) {
        ok = false;
        error = e instanceof Error ? e.message : String(e);
      }
    }

    if (!ok) {
      const short = error.split("\n")[0].slice(0, 120);
      this.set({ removing: null, note: `Could not remove ${basename(item.path)}${short ? `: ${short}` : "."}` });
      return;
    }

    if (this.options.dryRun && !this.options.demo) {
      const verb = forGood ? "delete" : `move to ${TRASH_NAME}`;
      this.set({ removing: null, note: `Dry run: would ${verb} ${basename(item.path)} (${size(item.size)}).` });
      return;
    }

    // Anything measured above or inside it is out of date now.
    forgetSizes(item.path);
    const culprits = { ...this.state.culprits };
    for (const path of Object.keys(culprits)) {
      if (path === item.path || descendant(item.path, path)) delete culprits[path];
    }
    this.state = { ...this.state, culprits };

    // Take the item out of every list that holds it, and shrink the folders above it.
    const { scan, stack, children } = this.state;
    const drop = (list: Item[]) => list.filter((i) => i.path !== item.path);
    const sizes = { ...scan.sizes, [category]: Math.max(0, scan.sizes[category] - item.size) };
    const items = { ...scan.items, [category]: drop(scan.items[category]) };
    const shrink = (list: Item[]) =>
      list.map((i) => (descendant(item.path, i.path) ? { ...i, size: Math.max(0, i.size - item.size) } : i));
    items[category] = shrink(items[category]);
    const nextStack = stack.map((level) => ({ ...level, size: Math.max(0, level.size - item.size) }));

    let space = scan;
    let measured = scan.measured;
    let freed = this.state.freed;
    let movedBytes = 0;
    if (forGood) {
      measured -= scan.sizes[category] - sizes[category];
    } else {
      // Still on disk, only in the Trash now.
      sizes.trash += item.size;
      measured += item.size - (scan.sizes[category] - sizes[category]);
      if (!IS_WINDOWS) items.trash = [{ path: trashed, size: item.size, dir: item.dir }, ...items.trash].sort((a, b) => b.size - a.size);
    }
    if (this.options.demo && forGood) {
      const taken = Math.min(item.size, scan.used);
      space = { ...scan, used: scan.used - taken, available: scan.available + taken };
      freed += taken;
    } else if (!this.pretend) {
      const after = await diskSpace(layout.drive);
      if (after.total > 0) space = { ...scan, ...after };
      sizes.system += unmeasuredBytes({ ...space, measured }) - unmeasuredBytes(scan);
      if (forGood) freed += Math.max(0, scan.used - space.used);
      else movedBytes = item.size;
    }

    const list = stack.length === 0 ? items[category] : drop(children);
    const verb = forGood ? "Deleted" : `Moved to ${TRASH_NAME}:`;
    const prefix = this.pretend ? "Dry run, nothing changed. Would have " + (forGood ? "deleted" : `moved to ${TRASH_NAME}`) : verb;
    this.set({
      scan: { ...space, sizes, items, measured },
      stack: nextStack,
      children: stack.length === 0 ? children : list,
      row: Math.min(this.state.row, Math.max(0, Math.min(list.length, MAX_ROWS) - 1)),
      removing: null,
      freed,
      movedToRecycleBinBytes: this.state.movedToRecycleBinBytes + movedBytes,
      note: `${prefix} ${basename(item.path)} (${size(item.size)}).${forGood || this.pretend ? "" : IS_WINDOWS ? " Space remains in use until you choose to empty the Recycle Bin in Windows." : " Empty the Trash to get the space back."}`,
    });
  }

  // ---- clearing a whole category ------------------------------------------

  /** The next thing worth clearing, or null. */
  suggestion(): Clearable | null {
    const { scan, action } = this.state;
    if (action) return action.id;
    if (scan.phase !== "done") return null;
    return CLEARABLE.find((id) => this.canClear(id)) ?? null;
  }

  canClear(id: CategoryId): id is Clearable {
    const { layout, scan } = this.state;
    return !!layout && !layout.lookOnly && (CLEARABLE as CategoryId[]).includes(id) && !(IS_WINDOWS && id === "trash") && scan.sizes[id] >= WORTH_CLEARING;
  }

  /** First press prepares and displays the exact plan; the second press confirms it. */
  press(id: Clearable) {
    if (this.state.action || this.state.removing || this.state.scan.phase !== "done" || !this.canClear(id)) return;
    const confirmed = this.state.confirm;
    if (confirmed?.kind === "category" && confirmed.id === id) {
      this.clearConfirm();
      void this.run(id, confirmed.items);
      return;
    }
    if (!IS_WINDOWS) {
      this.arm({ kind: "category", id });
      return;
    }

    const layout = this.state.layout;
    if (!layout) return;
    this.clearConfirm();
    const ticket = ++this.confirmationPlans;
    this.set({ note: `Preparing the ${CATEGORY[id].name} Recycle Bin plan…` });
    void (this.options.demo ? Promise.resolve(demoPlan(id, layout)) : plan(id, this.state.scan.items[id], layout)).then((items) => {
      if (ticket !== this.confirmationPlans || this.state.action || this.state.removing) return;
      if (items.length === 0) {
        this.set({ note: `${CATEGORY[id].name}: no items are eligible for cleanup.` });
        return;
      }
      this.arm({
        kind: "category",
        id,
        items,
        paths: items.map((item) => item.path),
        bytes: items.reduce((total, item) => total + item.size, 0),
      });
      this.set({ note: null });
    }).catch((error) => {
      if (ticket === this.confirmationPlans) this.set({ note: `Could not prepare cleanup: ${error instanceof Error ? error.message : String(error)}` });
    });
  }

  private arm(confirm: NonNullable<AppState["confirm"]>) {
    this.clearConfirm();
    this.set({ confirm });
    this.confirmTimer = setTimeout(() => this.set({ confirm: null }), IS_WINDOWS ? 15_000 : 4000);
  }

  private clearConfirm() {
    this.confirmationPlans++;
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    this.confirmTimer = null;
    if (this.state.confirm) this.set({ confirm: null });
  }

  private async run(id: Clearable, prepared?: Item[]) {
    const layout = this.state.layout;
    if (!layout || layout.lookOnly) return;
    const original = this.state.scan;
    const dryRun = this.options.dryRun && !this.options.demo;
    const before = original.sizes[id];
    this.listHandle?.cancel();
    this.set({ action: { id, current: "" }, note: null, hover: null, selected: id, stack: [], children: [], row: 0 });

    const items = prepared ?? (this.options.demo ? demoPlan(id, layout) : await plan(id, this.state.scan.items[id], layout));

    const onProgress = ({ path, freed, movedToRecycleBinBytes = 0 }: { path: string; freed: number; movedToRecycleBinBytes?: number }) => {
      const scan = this.state.scan;
      const taken = Math.min(freed + movedToRecycleBinBytes, scan.sizes[id]);
      const simulated = this.options.demo && !IS_WINDOWS ? Math.min(taken, scan.used) : 0;
      const sizes = { ...scan.sizes, [id]: scan.sizes[id] - taken };
      if (IS_WINDOWS && !dryRun) sizes.trash += taken;
      this.set({
        action: { id, current: path },
        scan: {
          ...scan,
          sizes,
          measured: dryRun || IS_WINDOWS ? scan.measured : scan.measured - taken,
          used: scan.used - simulated,
          available: scan.available + simulated,
        },
      });
    };

    let skipped = 0;
    let cleanupError = "";
    let movedEstimate = 0;
    const skippedPaths = new Set<string>();
    if (this.options.demo) {
      for (const item of items) {
        await new Promise((done) => setTimeout(done, 70));
        if (IS_WINDOWS) movedEstimate += item.size;
        onProgress({ path: item.path, freed: IS_WINDOWS ? 0 : item.size, movedToRecycleBinBytes: IS_WINDOWS ? item.size : 0 });
      }
    } else {
      const result = await clean(id, items, layout, { dryRun: this.options.dryRun, onProgress });
      skipped = result.skipped.length;
      movedEstimate = result.movedToRecycleBinBytes;
      for (const path of result.skipped) skippedPaths.add(IS_WINDOWS ? normalPath(path) : path);
      const first = result.errors?.[0];
      if (first) cleanupError = `${first.path}: ${first.error}`;
    }

    // Replace the running estimate with what is actually on disk now. Actual
    // reclamation is derived from the fresh filesystem measurement only.
    let scan = this.state.scan;
    let space = original;
    if (!this.pretend) {
      const [left, fresh] = await Promise.all([measure(id, layout), diskSpace(layout.drive)]);
      const sizes = { ...scan.sizes, [id]: left };
      const measured = scan.measured + (left - scan.sizes[id]);
      space = fresh.total > 0 ? fresh : space;
      scan = { ...scan, ...space, sizes, measured };
      sizes.system += unmeasuredBytes(scan) - unmeasuredBytes(original);
    }
    const estimateChange = Math.max(0, before - scan.sizes[id]);
    const actualFreed = !this.pretend && space.total > 0 ? Math.max(0, original.used - space.used) : 0;
    const remainingItems = IS_WINDOWS ? items.filter((item) => skippedPaths.has(normalPath(item.path))) : [];
    scan = { ...scan, items: { ...scan.items, [id]: remainingItems } };

    const outcome = this.options.demo && IS_WINDOWS
      ? "demo move to the Windows Recycle Bin (nothing changed)"
      : dryRun
        ? (IS_WINDOWS ? "would be moved to the Windows Recycle Bin" : "would be cleared")
        : IS_WINDOWS
          ? "moved to the Windows Recycle Bin (estimated)"
          : "cleared (estimated)";
    const parts = IS_WINDOWS
      ? [`${CATEGORY[id].name}: ${size(movedEstimate)} ${outcome}.`]
      : [`${CATEGORY[id].name}: ${size(estimateChange)} ${outcome}.`];
    if (!this.pretend && actualFreed > 0) parts.push(`${size(actualFreed)} actually reclaimed from a fresh disk measurement.`);
    if (IS_WINDOWS && !dryRun && !this.options.demo) parts.push("No disk space is reclaimed until you choose to empty the Recycle Bin in Windows.");
    if (skipped > 0) parts.push(
      IS_WINDOWS
        ? `${skipped} ${skipped === 1 ? "item was" : "items were"} not confirmed as recycled; inspect the listed path manually.`
        : `${skipped} ${skipped === 1 ? "item was" : "items were"} in use or protected and left alone.`,
    );
    if (cleanupError) parts.push(`First error: ${cleanupError}`);
    const sessionFreed = dryRun
      ? this.state.freed
      : this.options.demo
        ? this.state.freed + (IS_WINDOWS ? 0 : estimateChange)
        : this.state.freed + actualFreed;
    this.set({
      scan: dryRun ? original : scan,
      action: null,
      pane: "sidebar",
      freed: sessionFreed,
      movedToRecycleBinBytes: this.state.movedToRecycleBinBytes + (!dryRun && !this.options.demo ? movedEstimate : 0),
      note: parts.join(" "),
    });
  }

  stop() {
    this.scanHandle?.cancel();
    this.listHandle?.cancel();
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
  }
}

import { basename } from "node:path";
import { CATEGORIES, CATEGORY, type CategoryId } from "../core/categories";
import { classify, type Label, type Usage } from "../core/classify";
import {
  reviewRestriction,
  demoCulprit,
  demoUsage,
  findCulprit,
  forgetAllSizes,
  forgetSizes,
  usage as lookUpUsage,
  type Culprit,
  demoChildren,
  listFolder,
  reveal,
  type ListHandle,
} from "../core/browse";
import { demoDrives, demoLayout, startDemoScan } from "../core/demo";
import { listDrives, pickDrive, type Drive, type Partition } from "../core/drives";
import { size, tilde } from "../core/format";
import { layoutFor, type Layout } from "../core/layout";
import { FILE_MANAGER, IS_MAC, IS_WINDOWS, OS_NAME, TRASH_NAME } from "../core/platform";
import {
  categoryRecommendation,
  isReviewCategory,
  recommendationForItem,
  REVIEW_CATEGORIES,
  type Recommendation,
  type ReviewCategory,
} from "../core/recommendations";
import { normalPath } from "../core/windows/paths";
import { emptySnapshot, startScan, type Item, type ScanHandle, type ScanSnapshot } from "../core/scan";

export interface AnalysisProgress {
  id: CategoryId;
  current: string;
}

export type Pane = "sidebar" | "list";

export interface Level {
  path: string;
  size: number;
}

export interface AppState {
  drives: Drive[];
  drive: number;
  layout: Layout | null;
  unmounted: Partition[];
  scan: ScanSnapshot;
  selected: CategoryId;
  hover: CategoryId | null;
  pane: Pane;
  row: number;
  stack: Level[];
  children: Item[];
  listing: boolean;
  /** Read-only recommendation analysis in progress. */
  action: AnalysisProgress | null;
  /** Current informational recommendation; never an instruction executed by the app. */
  recommendation: Recommendation | null;
  note: string | null;
  usage: Record<string, Usage>;
  culprits: Record<string, Culprit | "pending">;
  junkOnly: boolean;
}

export interface Options {
  demo: boolean;
  drive?: string;
}

type Listener = () => void;

/** Sizes below this are not worth a prominent suggestion. */
const WORTH_REVIEW = 50e6;
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
    recommendation: null,
    note: null,
    usage: {},
    culprits: {},
    junkOnly: false,
  };
  private listeners = new Set<Listener>();
  private scanHandle: ScanHandle | null = null;
  private listHandle: ListHandle | null = null;
  private culpritHandle: ListHandle | null = null;
  private culpritQueue: Item[] = [];
  private usagePending = new Set<string>();
  private enrichScheduled = false;
  private scans = new Map<string, ScanSnapshot>();
  private loads = 0;

  constructor(readonly options: Options) {}

  get = (): AppState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
    if (
      patch.selected !== undefined ||
      patch.stack !== undefined ||
      patch.children !== undefined ||
      patch.row !== undefined ||
      patch.scan !== undefined ||
      patch.junkOnly !== undefined
    ) {
      this.scheduleEnrich();
    }
  }

  label(item: Item, state: AppState = this.state): Label {
    return classify(item, state.selected, state.usage[item.path]);
  }

  toggleJunkOnly() {
    this.set({ junkOnly: !this.state.junkOnly, row: 0, recommendation: null });
  }

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

  goToCulprit(row = this.state.row) {
    const item = this.entries()[row];
    const culprit = item ? this.state.culprits[item.path] : undefined;
    if (!item || !culprit || culprit === "pending" || culprit.chain.length === 0) return;
    this.listHandle?.cancel();
    this.dropCulpritWork();
    const path = [item, ...culprit.chain];
    const last = path[path.length - 1];
    const target = path[path.length - 2];
    const above = path.slice(0, path.length - 2).map((i) => ({ path: i.path, size: i.size }));
    this.set({ stack: [...this.state.stack, ...above], recommendation: null });
    this.openItem(target, last.path);
  }

  rescan() {
    if (this.state.action) return;
    this.stopWork();
    forgetAllSizes();
    this.scans.clear();
    this.set({ scan: emptySnapshot(), note: null, stack: [], children: [], listing: false, row: 0, culprits: {}, recommendation: null });
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
    this.dropCulpritWork();
  }

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
          note: `Could not discover volumes: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }
    try {
      const drive = this.state.drives[this.state.drive];
      if (ticket !== this.loads) return;
      if (!drive) {
        this.set({ scan: { ...emptySnapshot(), phase: "done" }, note: "No accessible volumes were found." });
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

  setDrive(index: number) {
    const { drives, drive, action } = this.state;
    if (action || drives.length < 2) return;
    const next = ((index % drives.length) + drives.length) % drives.length;
    if (next === drive) return;
    if (this.state.scan.phase === "done") this.scans.set(drives[drive].id, this.state.scan);
    this.stopWork();
    this.set({ drive: next, scan: emptySnapshot(), note: null, stack: [], children: [], listing: false, row: 0, pane: "sidebar", recommendation: null });
    void this.load();
  }

  nextDrive(step = 1) {
    this.setDrive(this.state.drive + step);
  }

  setHover(hover: CategoryId | null) {
    if (hover !== this.state.hover) this.set({ hover });
  }

  select(id: CategoryId, pane: Pane = this.state.pane) {
    if (id === this.state.selected && this.state.stack.length === 0) {
      if (pane !== this.state.pane) this.set({ pane });
      return;
    }
    this.listHandle?.cancel();
    this.dropCulpritWork();
    this.set({ selected: id, stack: [], children: [], listing: false, row: 0, pane, recommendation: null });
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

  entries(state: AppState = this.state): Item[] {
    const list = this.allEntries(state);
    return list.length > MAX_ROWS ? list.slice(0, MAX_ROWS) : list;
  }

  allEntries(state: AppState = this.state): Item[] {
    const list = state.stack.length === 0 ? state.scan.items[state.selected] : state.children;
    if (!state.junkOnly) return list;
    return list.filter((item) => {
      const { verdict } = this.label(item, state);
      return verdict === "junk" || verdict === "unused";
    });
  }

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

  scopeSize(state: AppState = this.state): number {
    const top = state.stack[state.stack.length - 1];
    return top ? top.size : state.scan.sizes[state.selected];
  }

  moveRow(delta: number) {
    const count = this.entries().length;
    if (count === 0) return;
    const row = Math.max(0, Math.min(count - 1, this.state.row + delta));
    if (row !== this.state.row) this.set({ row, recommendation: null });
  }

  setRow(row: number) {
    if (row !== this.state.row) this.set({ row: row, pane: "list", recommendation: null });
  }

  open(row = this.state.row) {
    const item = this.entries()[row];
    if (!item || !item.dir) return;
    this.listHandle?.cancel();
    this.dropCulpritWork();
    const stack = [...this.state.stack, { path: item.path, size: item.size }];
    if (this.options.demo) {
      this.set({ stack, children: demoChildren(this.state.selected, item.path, item.size, stack.length), listing: false, row: 0, pane: "list", note: null, recommendation: null });
      return;
    }
    this.set({ stack, children: [], listing: true, row: 0, pane: "list", note: null, recommendation: null });
    const handle = listFolder(item.path, (children, done) => {
      if (this.listHandle !== handle) return;
      this.set({ children, listing: !done });
    }, this.state.layout?.foreign);
    this.listHandle = handle;
  }

  back() {
    const { stack } = this.state;
    if (stack.length === 0) {
      this.set({ pane: "sidebar", recommendation: null });
      return;
    }
    this.listHandle?.cancel();
    this.dropCulpritWork();
    const left = stack[stack.length - 1];
    const rest = stack.slice(0, -1);
    if (rest.length === 0) {
      const row = Math.max(0, this.state.scan.items[this.state.selected].findIndex((i) => i.path === left.path));
      this.set({ stack: [], children: [], listing: false, row, recommendation: null });
      return;
    }
    const parent = rest[rest.length - 1];
    this.set({ stack: rest.slice(0, -1), recommendation: null });
    this.openItem({ path: parent.path, size: parent.size, dir: true }, left.path);
  }

  private openItem(item: Item, highlight?: string) {
    const stack = [...this.state.stack, { path: item.path, size: item.size }];
    const pick = (children: Item[]) => Math.max(0, children.findIndex((c) => c.path === highlight));
    if (this.options.demo) {
      const children = demoChildren(this.state.selected, item.path, item.size, stack.length);
      this.set({ stack, children, listing: false, row: pick(children), pane: "list", recommendation: null });
      return;
    }
    this.set({ stack, children: [], listing: true, row: 0, pane: "list", recommendation: null });
    const handle = listFolder(item.path, (children, done) => {
      if (this.listHandle !== handle) return;
      this.set({ children, listing: !done, row: done ? pick(children) : this.state.row });
    }, this.state.layout?.foreign);
    this.listHandle = handle;
  }

  jump(level: number) {
    const { stack } = this.state;
    if (level >= stack.length - 1) return;
    this.listHandle?.cancel();
    this.dropCulpritWork();
    if (level < 0) {
      this.set({ stack: [], children: [], listing: false, row: 0, recommendation: null });
      return;
    }
    const target = stack[level];
    this.set({ stack: stack.slice(0, level), recommendation: null });
    this.openItem({ path: target.path, size: target.size, dir: true });
  }

  // ---- read-only recommendations -------------------------------------------

  /** Why an item is excluded from recommendations. */
  reviewLimit(item: Item | undefined): string | null {
    if (!item) return "Nothing selected.";
    const { layout, selected } = this.state;
    if (!layout) return "Still working out this volume.";
    if (layout.lookOnly) return layout.lookOnly.charAt(0).toUpperCase() + layout.lookOnly.slice(1) + ".";
    if (selected === "system") return `${OS_NAME} manages this data; review it with ${IS_MAC ? "macOS" : IS_WINDOWS ? "Windows" : "system"} tools.`;
    if (IS_WINDOWS && selected === "trash") return `${TRASH_NAME} review is informational; this app never modifies it.`;
    if (this.options.demo) return null;
    return reviewRestriction(item.path, layout);
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

  /** Show an informational recommendation for the selected item. */
  reviewItem(row = this.state.row) {
    const item = this.entries()[row];
    if (!item || row !== this.state.row) this.set({ row, pane: "list" });
    const reason = this.reviewLimit(item);
    if (reason) {
      this.set({ note: reason, recommendation: null });
      return;
    }
    const recommendation = recommendationForItem(item, this.state.selected, this.label(item));
    this.set({
      recommendation,
      note: `${recommendation.title} · ${size(recommendation.estimatedBytes)} estimated cleanup opportunity. Review it yourself; this app changes nothing.`,
    });
  }

  canReview(id: CategoryId): id is ReviewCategory {
    return isReviewCategory(id) && this.state.scan.phase === "done" && this.state.scan.sizes[id] >= WORTH_REVIEW;
  }

  suggestion(): ReviewCategory | null {
    if (this.state.scan.phase !== "done") return null;
    const candidates = REVIEW_CATEGORIES
      .filter((id) => this.state.scan.sizes[id] >= WORTH_REVIEW)
      .sort((a, b) => this.state.scan.sizes[b] - this.state.scan.sizes[a]);
    return candidates[0] ?? null;
  }

  /** Prepare a recommendation for the requested supported category only. */
  async reviewCategory(id: CategoryId = this.state.selected) {
    if (this.state.scan.phase !== "done") {
      this.set({ note: "Wait for the storage analysis to finish before preparing recommendations.", recommendation: null });
      return;
    }
    if (!isReviewCategory(id)) {
      this.set({
        note: `Category recommendations are not available for ${CATEGORY[id]?.name ?? id}. No other category was substituted.`,
        recommendation: null,
      });
      return;
    }
    const category = id;
    const items = this.state.scan.items[category].slice(0, MAX_ROWS);
    if (items.length === 0) {
      this.set({ note: `${CATEGORY[category].name}: no measured items to review.`, recommendation: null });
      return;
    }
    const recommendation: Recommendation = categoryRecommendation(category, items);
    this.set({
      action: null,
      selected: category,
      recommendation,
      note: `Estimated cleanup opportunity: ${size(recommendation.estimatedBytes)}. Recommendation only; this app changes nothing.`,
    });
  }

  stop() {
    this.scanHandle?.cancel();
    this.listHandle?.cancel();
    this.dropCulpritWork();
  }
}

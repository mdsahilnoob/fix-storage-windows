import { Box, Text, useRect } from "@zenbu-labs/pixel";
import type { Color, NodeHandle, Root, Style } from "@zenbu-labs/pixel";
import { basename, dirname } from "node:path";
import { useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { CATEGORIES, CATEGORY, TIER_LABEL, type Category, type CategoryId, type Rgb, type Tier } from "../core/categories";
import { deletesForGood, type Culprit } from "../core/browse";
import { classify, shortAge, type Verdict } from "../core/classify";
import type { Clearable } from "../core/clean";
import { capacity, gb, size, tilde } from "../core/format";
import { IS_MAC, IS_WINDOWS, REVEAL_LABEL, TRASH_NAME } from "../core/platform";
import type { Item } from "../core/scan";
import { BAR_ROWS, BarCanvas, HEADROOM_ROWS, diskSegments, type BarModel } from "./bar";
import { MAX_ROWS, type AppState, type Store } from "./store";

// Everything is one monospace face at one size, like the rest of the terminal.
// Hierarchy comes from color and weight only. No borders, no panels.

const BG: Rgb = [0, 0, 0];
const FG: Color = "#e6e6e6";
const MUTED: Color = "#8c8c8c";
const FAINT: Color = "#4f4f4f";
const RED: Color = "#f87171";
const GREEN: Color = "#4ade80";
const AMBER: Color = "#fbbf24";

const TIER_COLOR: Record<Tier, Color> = { safe: GREEN, review: AMBER, keep: MUTED };

const VERDICT: Record<Verdict, { color: Rgb; text: Color; tag: string }> = {
  junk: { color: [74, 222, 128], text: GREEN, tag: "junk" },
  unused: { color: [251, 191, 36], text: AMBER, tag: "unused" },
  yours: { color: [120, 120, 120], text: MUTED, tag: "" },
  system: { color: [100, 116, 139], text: "#7c8aa0", tag: "system" },
};

/** Width of n monospace characters. Text drops trailing spaces, so columns get real widths instead of padEnd. */
const ch = (fs: number, n: number) => fs * 0.6 * n;

/** macOS puts a narrow no-break space before AM/PM in screenshot names; many fonts draw it as a box. */
const clean = (name: string) => name.replace(/[\u202f\u00a0]/g, " ");

const ACTION = {
  caches: { label: "clear caches", doing: "clearing caches" },
  trash: { label: "empty trash", doing: "emptying the trash" },
} as const;

const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%");
const rgba = (c: Rgb, a: number): Color => [c[0], c[1], c[2], Math.round(Math.max(0, Math.min(1, a)) * 255)] as unknown as Color;

interface Ctx {
  state: AppState;
  store: Store;
  /** Font size: one terminal cell's worth of text. */
  fs: number;
}

/** A run of monospace text. Everything on screen is built from these. */
function T({
  children,
  fs,
  color = FG,
  bold,
  style,
  onClick,
}: {
  children: ReactNode;
  fs: number;
  color?: Color;
  bold?: boolean;
  style?: Style;
  onClick?: () => void;
}) {
  return (
    <Text
      style={{
        fontFamily: "monospace",
        fontSize: fs,
        color,
        fontWeight: bold ? 700 : 400,
        selectable: false,
        wrap: false,
        flexShrink: 0,
        ...(onClick ? { pointerShape: "pointer", hoverColor: FG } : {}),
        ...style,
      }}
      onClick={onClick}
    >
      {children}
    </Text>
  );
}

/** "key label", the way terminal tools print their shortcuts. Clickable. */
function Hint({ k, label, fs, color = MUTED, keyColor = FG, onClick }: { k: string; label: string; fs: number; color?: Color; keyColor?: Color; onClick?: () => void }) {
  return (
    <Box style={{ flexShrink: 0, pointerShape: onClick ? "pointer" : "default" }} onClick={onClick}>
      <T fs={fs} color={keyColor} bold>
        {k}
      </T>
      <T fs={fs} color={color} style={onClick ? { hoverColor: FG } : undefined}>
        {" " + label}
      </T>
    </Box>
  );
}

// ---- dot-matrix ---------------------------------------------------------------

function hash(a: number, b: number): number {
  let h = Math.imul(a + 374761393, 668265263) ^ Math.imul(b + 1274126177, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * A small dot-matrix bar, the same pixel language as the big meter: lit dots
 * in the category color with the odd white one, unlit dots for the rest.
 */
function Dots({ fraction, color, count, fs, seed, rows = 1, dim = false }: { fraction: number; color: Rgb; count: number; fs: number; seed: number; rows?: number; dim?: boolean }) {
  const dot = Math.max(2, Math.round(fs * 0.26));
  const gap = Math.max(1, Math.round(fs * 0.14));
  const lit = fraction > 0 ? Math.max(1, Math.round(fraction * count)) : 0;
  return (
    <Box style={{ flexDirection: "column", gap, flexShrink: 0, justifyContent: "center" }}>
      {Array.from({ length: rows }, (_, r) => (
        <Box key={r} style={{ gap }}>
          {Array.from({ length: count }, (_, i) => {
            const on = i < lit;
            const k = hash(i + seed * 31, r + seed);
            const fill: Color = !on
              ? "#1c1c1c"
              : k > 0.9 && !dim
                ? "#ffffff"
                : rgba(color, (dim ? 0.35 : 0.55 + k * 0.45));
            return <Box key={i} style={{ width: dot, height: dot, cornerRadius: dot / 2, background: fill }} />;
          })}
        </Box>
      ))}
    </Box>
  );
}

// ---- the big meter ----------------------------------------------------------------

function barModel(state: AppState): BarModel {
  const { scan } = state;
  const focus = scan.phase === "done" && !state.action ? state.selected : null;
  return {
    segments: diskSegments(scan),
    hover: state.hover ?? focus,
    scanning: scan.phase === "scanning",
    clearing: state.action?.id ?? null,
  };
}

function Meter({ root, store, fs }: { root: Root; store: Store; fs: number }) {
  const ref = useRef<NodeHandle>(null);
  const rect = useRect(ref);
  const surface = useMemo(() => root.createSurface(), [root]);
  const canvas = useMemo(() => new BarCanvas(surface, BG), [surface]);
  const cell = Math.max(4, Math.round(fs * 0.62));
  const height = (BAR_ROWS + HEADROOM_ROWS) * cell;

  useEffect(() => {
    if (rect) canvas.resize(rect.width, rect.height, cell);
  }, [canvas, rect?.width, rect?.height, cell]);

  useEffect(() => {
    let last = Date.now();
    let idle = 0;
    const timer = setInterval(() => {
      const now = Date.now();
      if (idle > 0 && --idle > 0) return;
      canvas.setModel(barModel(store.get()));
      const moving = canvas.step((now - last) / 1000);
      last = now;
      idle = moving ? 0 : 6;
    }, 16);
    return () => {
      clearInterval(timer);
      surface.close();
    };
  }, [canvas, store, surface]);

  return (
    <Box
      ref={ref}
      surface={surface}
      style={{ width: "100%", height, flexShrink: 0 }}
      onMouseMove={({ x, y }) => store.setHover(canvas.hit(x, y) as CategoryId | null)}
      onMouseLeave={() => store.setHover(null)}
      onClick={({ x, y }) => {
        const id = canvas.hit(x, y) as CategoryId | null;
        if (id) store.select(id, "list");
      }}
    />
  );
}

/** Character fallback for terminals without graphics. */
function CellMeter({ state, fs }: { state: AppState; fs: number }) {
  const segments = diskSegments(state.scan);
  const filled = segments.reduce((sum, segment) => sum + segment.fraction, 0);
  return (
    <Box style={{ width: "100%", height: fs * 1.4, flexShrink: 0 }}>
      {segments.map(({ id, color, fraction }) => (
        <Box key={id} style={{ flexGrow: fraction, flexBasis: 0, background: state.selected === id ? color : rgba(color, 0.6) }} />
      ))}
      <Box style={{ flexGrow: Math.max(0, 1 - filled), flexBasis: 0, background: "#141414" }} />
    </Box>
  );
}

// ---- top lines ----------------------------------------------------------------------

/** The drives, the one on screen highlighted. Click one, or press v or its number, to switch. */
function DriveTabs({ state, store, fs }: Ctx) {
  const { drives } = state;
  if (drives.length <= 1) {
    return (
      <T fs={fs} color={FAINT} style={{ margin: { left: ch(fs, 2) } }}>
        {drives[0]?.name ?? (IS_MAC ? "Macintosh HD" : "")}
      </T>
    );
  }
  return (
    <Box style={{ flexShrink: 0, margin: { left: ch(fs, 2) }, gap: ch(fs, 2) }}>
      {drives.map((drive, i) => {
        const on = i === state.drive;
        return (
          <T key={drive.id} fs={fs} bold={on} color={on ? FG : FAINT} onClick={on ? undefined : () => store.setDrive(i)}>
            {drive.name}
          </T>
        );
      })}
    </Box>
  );
}

function TopLine(ctx: Ctx) {
  const { state, store, fs } = ctx;
  const mode = store.options.demo ? "demo disk" : store.options.dryRun ? "dry run" : null;
  const { scan, action } = state;
  let status: ReactNode;
  if (action) {
    status = (
      <>
        <T fs={fs} color={CATEGORY[action.id].color} style={{ margin: { right: ch(fs, 2) } }}>{ACTION[action.id].doing + (store.pretend ? " (dry run)" : "")}</T>
        <T fs={fs} color={FAINT} style={{ flexShrink: 1, ellipsis: true }}>{tilde(action.current)}</T>
      </>
    );
  } else if (scan.phase === "scanning") {
    status = (
      <>
        <T fs={fs} color={FG} style={{ margin: { right: ch(fs, 2) } }}>measuring</T>
        <T fs={fs} color={FAINT} style={{ flexShrink: 1, ellipsis: true }}>{tilde(scan.current)}</T>
      </>
    );
  } else {
    const hidden = scan.blocked.length;
    const unmounted = state.unmounted.length;
    status = (
      <T fs={fs} color={FAINT} style={{ flexShrink: 1, ellipsis: true }}>
        {hidden > 0
          ? `${hidden} folders unreadable · ${IS_MAC ? "grant Full Disk Access" : "counted as system data"}`
          : unmounted > 0
            ? `${unmounted} ${unmounted === 1 ? "partition" : "partitions"} not mounted · fix-storage --drives`
            : "scan complete"}
      </T>
    );
  }
  return (
    <Box style={{ justifyContent: "space-between", gap: fs * 2, flexShrink: 0 }}>
      <Box style={{ flexShrink: 0 }}>
        <T fs={fs} bold>fix-storage</T>
        <DriveTabs {...ctx} />
        {mode ? <T fs={fs} color={AMBER} style={{ margin: { left: ch(fs, 2) } }}>{mode}</T> : null}
        {state.layout?.lookOnly ? <T fs={fs} color={AMBER} style={{ margin: { left: ch(fs, 2) } }}>look only</T> : null}
      </Box>
      <Box style={{ flexShrink: 1, minWidth: 0, justifyContent: "end" }}>{status}</Box>
    </Box>
  );
}

function Sep({ fs }: { fs: number }) {
  return (
    <T fs={fs} color={FAINT} style={{ margin: { left: ch(fs, 3), right: ch(fs, 3) } }}>
      ·
    </T>
  );
}

function Totals({ state, fs }: Ctx) {
  const { scan } = state;
  const known = scan.total > 0;
  return (
    <Box style={{ justifyContent: "space-between", flexShrink: 0 }}>
      <Box style={{ flexShrink: 0 }}>
        <T fs={fs} bold>{known ? gb(scan.used) : "…"}</T>
        <T fs={fs} color={MUTED}>{known ? ` used of ${capacity(scan.total)}` : " used"}</T>
        <Sep fs={fs} />
        <T fs={fs}>{known ? gb(scan.available) : "…"}</T>
        <T fs={fs} color={MUTED}>{" free"}</T>
        <Sep fs={fs} />
        <T fs={fs}>{known ? pct(scan.used, scan.total) : "…"}</T>
        <T fs={fs} color={MUTED}>{" full"}</T>
      </Box>
      {IS_WINDOWS || state.freed > 0 ? (
        <T fs={fs} color={GREEN}>{IS_WINDOWS ? `~${gb(state.freed)} net free-space increase observed · ~${gb(state.movedToRecycleBinBytes)} in ${TRASH_NAME}` : `~${gb(state.freed)} cleared this session`}</T>
      ) : !IS_MAC && state.drives[state.drive] ? (
        <T fs={fs} color={FAINT} style={{ flexShrink: 1, ellipsis: true, margin: { left: ch(fs, 2) } }}>
          {driveDetail(state)}
        </T>
      ) : null}
    </Box>
  );
}

/** "ext4 · /dev/nvme0n1p2 · games · /mnt/games" */
function driveDetail(state: AppState): string {
  const drive = state.drives[state.drive];
  const parts = [drive.fstype, drive.device, drive.label, drive.mount !== drive.name ? drive.mount : ""];
  if (drive.readOnly) parts.push("read-only");
  return parts.filter(Boolean).join(" · ");
}

// ---- left column: categories ----------------------------------------------------------

function CategoryLine({ category, state, store, fs }: Ctx & { category: Category }) {
  const selected = state.selected === category.id;
  const focused = selected && state.pane === "sidebar";
  const bytes = state.scan.sizes[category.id];
  const largest = Math.max(1, ...CATEGORIES.map((c) => state.scan.sizes[c.id]));
  const dimmed = state.hover !== null && state.hover !== category.id && !selected;
  return (
    <Box
      style={{ alignItems: "center", gap: fs * 0.6, height: fs * 1.75, flexShrink: 0, pointerShape: "pointer" }}
      onClick={() => store.select(category.id, "list")}
      onMouseEnter={() => store.setHover(category.id)}
      onMouseLeave={() => store.setHover(null)}
    >
      <T fs={fs} color={selected ? category.color : FAINT} bold style={{ width: ch(fs, 1) }}>
        {focused ? "›" : selected ? "·" : ""}
      </T>
      <T fs={fs} color={category.color} style={{ width: ch(fs, 1) }}>■</T>
      <T fs={fs} color={selected ? FG : dimmed ? FAINT : "#b5b5b5"} bold={selected} style={{ width: ch(fs, 12) }}>
        {category.name}
      </T>
      <T fs={fs} color={selected ? FG : MUTED} style={{ width: ch(fs, 9), justifyContent: "end" }}>{gb(bytes).padStart(9)}</T>
      <Dots fraction={bytes / largest} color={category.color} count={14} fs={fs} seed={category.id.length * 7 + category.name.charCodeAt(0)} dim={dimmed} />
    </Box>
  );
}

function QuickWins({ state, store, fs }: Ctx) {
  const lookOnly = state.layout?.lookOnly;
  if (lookOnly) {
    return (
      <Box style={{ flexDirection: "column", gap: fs * 0.35 }}>
        {lookOnly.split(" · ").map((line, i) => (
          <T key={i} fs={fs} color={i === 0 ? AMBER : FAINT} style={{ wrap: true, flexShrink: 1 }}>
            {line}
          </T>
        ))}
      </Box>
    );
  }
  if (state.scan.phase !== "done") return <T fs={fs} color={FAINT}>looking for space you can get back…</T>;
  const ids = (["caches", "trash"] as Clearable[]).filter((id) => store.canClear(id) || state.action?.id === id);
  if (ids.length === 0) return <T fs={fs} color={FAINT}>nothing left that is safe to clear</T>;
  const total = ids.reduce((sum, id) => sum + state.scan.sizes[id], 0);
  const busy = state.action !== null || state.removing !== null;
  return (
    <Box style={{ flexDirection: "column", gap: fs * 0.35 }}>
      <Box>
        <T fs={fs} color={GREEN} bold>{gb(total)}</T>
        <T fs={fs} color={MUTED}>{" safe to clear"}</T>
      </Box>
      {ids.map((id) => {
        const armed = state.confirm?.kind === "category" && state.confirm.id === id;
        return (
          <Box key={id} style={{ gap: fs * 0.6 }}>
            <T fs={fs} color={CATEGORY[id].color}>■</T>
            {armed ? (
              <T fs={fs} color={RED} onClick={() => store.press(id)}>{IS_WINDOWS ? `move ${gb(state.confirm.bytes ?? state.scan.sizes[id])} to the Recycle Bin? press again` : `delete ${gb(state.scan.sizes[id])} for good? press again`}</T>
            ) : (
              <Box style={{ pointerShape: busy ? "default" : "pointer" }} onClick={busy ? undefined : () => store.press(id)}>
                <T fs={fs} color={busy ? FAINT : MUTED} style={{ width: ch(fs, 13) }}>{ACTION[id].label}</T>
                <T fs={fs} color={busy ? FAINT : MUTED}>{gb(state.scan.sizes[id]).padStart(9)}</T>
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

function Categories(ctx: Ctx & { width: number }) {
  const { state, fs, width } = ctx;
  return (
    <Box style={{ flexDirection: "column", width, flexShrink: 0, gap: fs * 0.2 }}>
      <T fs={fs} color={state.pane === "sidebar" ? MUTED : FAINT} style={{ margin: { bottom: fs * 0.4, left: ch(fs, 2) } }}>
        categories
      </T>
      {CATEGORIES.map((category) => (
        <CategoryLine key={category.id} {...ctx} category={category} />
      ))}
      <Box style={{ flexGrow: 1 }} />
      <Box style={{ padding: { left: fs * 1.2 } }}>
        <QuickWins {...ctx} />
      </Box>
    </Box>
  );
}

// ---- right column: what is inside ---------------------------------------------------

function Breadcrumb({ state, store, fs }: Ctx) {
  const category = CATEGORY[state.selected];
  const parts = [{ label: category.name, level: -1 }, ...state.stack.map((s, i) => ({ label: basename(s.path), level: i }))];
  return (
    <Box style={{ flexShrink: 1, overflow: "hidden" }}>
      {parts.map((part, i) => {
        const last = i === parts.length - 1;
        return (
          <Box key={i} style={{ flexShrink: last ? 1 : 0 }}>
            {i > 0 ? <T fs={fs} color={FAINT}>{" / "}</T> : null}
            <T
              fs={fs}
              bold={last}
              color={last ? category.color : MUTED}
              style={{ flexShrink: last ? 1 : 0, ellipsis: true }}
              onClick={last ? undefined : () => store.jump(part.level)}
            >
              {part.label}
            </T>
          </Box>
        );
      })}
    </Box>
  );
}

function InsideHeader(ctx: Ctx) {
  const { state, store, fs } = ctx;
  const category = CATEGORY[state.selected];
  const scope = store.scopeSize();
  const top = state.stack[state.stack.length - 1];
  const canClear = !top && store.canClear(category.id);
  const armed = canClear && state.confirm?.kind === "category" && state.confirm.id === category.id;
  return (
    <Box style={{ flexDirection: "column", gap: fs * 0.35, flexShrink: 0 }}>
      <Box style={{ justifyContent: "space-between", gap: fs * 2 }}>
        <Breadcrumb {...ctx} />
        <Box style={{ flexShrink: 0 }}>
          <T fs={fs} bold>{gb(scope)}</T>
          <T fs={fs} color={MUTED} style={{ margin: { left: ch(fs, 2), right: ch(fs, 2) } }}>
            {state.scan.total > 0 ? `est. ${pct(scope, state.scan.total)} of capacity` : "estimated"}
          </T>
          <T fs={fs} color={TIER_COLOR[category.tier]}>{TIER_LABEL[category.tier].toLowerCase()}</T>
        </Box>
      </Box>
      <Box style={{ justifyContent: "space-between", gap: fs * 2 }}>
        <T fs={fs} color={FAINT} style={{ flexShrink: 1, ellipsis: true }}>
          {top ? tilde(top.path) : category.blurb}
        </T>
        {canClear ? (
          armed ? (
            <T fs={fs} color={RED} onClick={() => store.press(category.id as Clearable)}>{IS_WINDOWS ? `c again to recycle ${gb(state.confirm.bytes ?? scope)}` : `c again to delete all ${gb(scope)}`}</T>
          ) : (
            <Hint fs={fs} k="c" label={ACTION[category.id as Clearable].label} keyColor={GREEN} onClick={() => store.press(category.id as Clearable)} />
          )
        ) : null}
      </Box>
      <Reclaimable {...ctx} />
    </Box>
  );
}

/** One line: how much of what is listed here looks like junk, and the filter to see only that. */
function Reclaimable({ state, store, fs }: Ctx) {
  const { junk, unused } = store.reclaimable();
  if (junk + unused < 1e6 && !state.junkOnly) return null;
  return (
    <Box style={{ justifyContent: "space-between", gap: fs * 2, margin: { top: fs * 0.3 } }}>
      <Box style={{ flexShrink: 1 }}>
        {junk >= 1e6 ? (
          <>
            <T fs={fs} color={GREEN} bold>{size(junk)}</T>
            <T fs={fs} color={MUTED} style={{ margin: { left: ch(fs, 1) } }}>junk</T>
          </>
        ) : null}
        {junk >= 1e6 && unused >= 1e6 ? <Sep fs={fs} /> : null}
        {unused >= 1e6 ? (
          <>
            <T fs={fs} color={AMBER} bold>{size(unused)}</T>
            <T fs={fs} color={MUTED} style={{ margin: { left: ch(fs, 1) } }}>probably unused</T>
          </>
        ) : null}
      </Box>
      <Hint
        fs={fs}
        k="f"
        label={state.junkOnly ? "show everything" : "show only junk & unused"}
        keyColor={state.junkOnly ? AMBER : FG}
        onClick={() => store.toggleJunkOnly()}
      />
    </Box>
  );
}

const DOTS = 16;

/** Path of `path` relative to the folder `from`, e.g. "a/b/model.bin". */
const relative = (from: string, path: string) => {
  if (IS_WINDOWS && path.toLowerCase().startsWith(from.toLowerCase() + "\\")) return path.slice(from.length + 1);
  return path.startsWith(from + "/") ? path.slice(from.length + 1) : path;
};

/** Is a culprit worth printing under its folder without being asked? */
function telling(item: Item, culprit: Culprit | "pending" | undefined): culprit is Culprit {
  if (!culprit || culprit === "pending" || culprit.chain.length === 0) return false;
  const last = culprit.chain[culprit.chain.length - 1];
  return last.size >= 1e9 || last.size >= item.size * 0.6;
}

function ItemLine({ item, index, max, rowRef, ...ctx }: Ctx & { item: Item; index: number; max: number; rowRef: (node: NodeHandle | null) => void }) {
  const { state, store, fs } = ctx;
  const category = CATEGORY[state.selected];
  const selected = state.row === index;
  const focused = selected && state.pane === "list";
  const label = store.label(item);
  const verdict = VERDICT[label.verdict];
  const used = state.usage[item.path];
  const name = clean(basename(item.path) || item.path);
  return (
    <Box
      ref={rowRef}
      style={{ alignItems: "center", gap: ch(fs, 1), height: fs * 1.75, flexShrink: 0, pointerShape: "pointer" }}
      onClick={() => (selected && item.dir ? store.open(index) : store.setRow(index))}
    >
      <T fs={fs} color={focused ? category.color : FAINT} bold style={{ width: ch(fs, 1) }}>
        {focused ? "›" : selected ? "·" : ""}
      </T>
      <T fs={fs} color={item.dir ? category.color : FAINT} style={{ width: ch(fs, 1) }}>{item.dir ? "▸" : ""}</T>
      <Box style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, overflow: "hidden" }}>
        <T fs={fs} color={state.removing === item.path ? FAINT : selected ? FG : "#b5b5b5"} bold={selected} style={{ flexShrink: 1, ellipsis: true }}>
          {name + (item.dir ? "/" : "")}
        </T>
        {state.stack.length === 0 ? (
          <T fs={fs} color={FAINT} style={{ flexShrink: 2, ellipsis: true, margin: { left: ch(fs, 2) } }}>{tilde(dirname(item.path))}</T>
        ) : null}
      </Box>
      <T fs={fs} color={verdict.text} style={{ width: ch(fs, 6) }}>{verdict.tag}</T>
      <T fs={fs} color={selected ? FG : MUTED}>{size(item.size).padStart(8)}</T>
      <Dots fraction={item.size / Math.max(1, max)} color={label.verdict === "yours" ? category.color : verdict.color} count={DOTS} fs={fs} seed={index + 3} dim={label.verdict === "yours" && !selected} />
      <T fs={fs} color={FAINT}>{pct(item.size, store.scopeSize()).padStart(4)}</T>
      <T fs={fs} color={used && Date.now() - used.at > 180 * 864e5 ? AMBER : FAINT}>{(used ? shortAge(Date.now() - used.at) : "").padStart(6)}</T>
    </Box>
  );
}

/** "└ mostly in a/b/c.mov  31.2 GB · 77%", printed under a folder. */
function CulpritLine({ item, culprit, fs, color, category }: { item: Item; culprit: Culprit; fs: number; color: Color; category: CategoryId }) {
  const last = culprit.chain[culprit.chain.length - 1];
  const verdict = classify(last, category).verdict;
  return (
    <Box style={{ alignItems: "center", height: fs * 1.45, flexShrink: 0, padding: { left: ch(fs, 4) }, overflow: "hidden" }}>
      <T fs={fs} color={FAINT} style={{ margin: { right: ch(fs, 1) } }}>└ mostly in</T>
      <T fs={fs} color={color} style={{ flexShrink: 1, ellipsis: true }}>{clean(relative(item.path, last.path)) + (last.dir ? "/" : "")}</T>
      <T fs={fs} color={MUTED} style={{ margin: { left: ch(fs, 2) } }}>{size(last.size)}</T>
      <T fs={fs} color={FAINT} style={{ margin: { left: ch(fs, 1) } }}>{`· ${pct(last.size, item.size)}`}</T>
      {VERDICT[verdict].tag && verdict !== "yours" ? (
        <T fs={fs} color={VERDICT[verdict].text} style={{ margin: { left: ch(fs, 2) } }}>{VERDICT[verdict].tag}</T>
      ) : null}
    </Box>
  );
}

/** What the highlighted item is, where its space is, and what you can do with it. */
function ItemDetails({ item, index, ...ctx }: Ctx & { item: Item; index: number }) {
  const { state, store, fs } = ctx;
  const forGood = deletesForGood(state.selected);
  const blocked = store.blocked(item);
  const armed = state.confirm?.kind === "item" && state.confirm.path === item.path;
  const removing = state.removing === item.path;
  const label = store.label(item);
  const verdict = VERDICT[label.verdict];
  const culprit = item.dir ? state.culprits[item.path] : undefined;
  const hasCulprit = culprit && culprit !== "pending" && culprit.chain.length > 0;
  const indent = { padding: { left: ch(fs, 4) } };
  const line = { alignItems: "center", height: fs * 1.45, flexShrink: 0, overflow: "hidden" } as const;

  return (
    <Box style={{ flexDirection: "column", flexShrink: 0, margin: { bottom: fs * 0.3 } }}>
      {label.reason || label.verdict !== "yours" ? (
        <Box style={{ ...line, ...indent }}>
          <T fs={fs} color={verdict.text} bold>{label.verdict === "unused" ? "probably unused" : label.verdict}</T>
          {label.reason ? <T fs={fs} color={MUTED} style={{ flexShrink: 1, ellipsis: true, margin: { left: ch(fs, 1) } }}>{`· ${label.reason}`}</T> : null}
        </Box>
      ) : null}

      {item.dir && culprit === "pending" ? (
        <Box style={{ ...line, ...indent }}>
          <T fs={fs} color={FAINT}>└ finding what is taking the space…</T>
        </Box>
      ) : hasCulprit ? (
        <CulpritLine item={item} culprit={culprit} fs={fs} color={FG} category={state.selected} />
      ) : item.dir && culprit && culprit !== "pending" && culprit.top.length > 1 ? (
        <Box style={{ ...line, ...indent }}>
          <T fs={fs} color={FAINT} style={{ margin: { right: ch(fs, 1) } }}>└ spread out:</T>
          <T fs={fs} color={MUTED} style={{ flexShrink: 1, ellipsis: true }}>
            {culprit.top.map((t) => `${clean(basename(t.path))} ${size(t.size)}`).join("  ·  ")}
          </T>
        </Box>
      ) : null}

      <Box style={{ ...line, ...indent, gap: ch(fs, 3) }}>
        {removing ? (
          <T fs={fs} color={MUTED}>{forGood ? "deleting…" : "moving to trash…"}</T>
        ) : (
          <>
            {item.dir ? <Hint fs={fs} k="→" label="open" onClick={() => store.open(index)} /> : null}
            {hasCulprit ? <Hint fs={fs} k="g" label="go to culprit" keyColor={AMBER} onClick={() => store.goToCulprit(index)} /> : null}
            <Hint fs={fs} k="o" label={REVEAL_LABEL} onClick={() => void store.reveal(index)} />
            {state.selected === "system" ? null : armed ? (
              <T fs={fs} color={RED} bold onClick={() => store.removeItem(index)}>
                {forGood ? `⌫ again to delete ${size(item.size)} for good` : `⌫ again to move ${size(item.size)} to trash`}
              </T>
            ) : blocked ? (
              <T fs={fs} color={FAINT}>{`can't remove: ${blocked.toLowerCase()}`}</T>
            ) : (
              <Hint fs={fs} k="⌫" label={forGood ? "delete" : "move to trash"} keyColor={RED} onClick={() => store.removeItem(index)} />
            )}
          </>
        )}
      </Box>
    </Box>
  );
}

function Empty({ state, store, fs }: Ctx) {
  const id = state.selected;
  let text: string;
  if (state.listing) text = "measuring what is inside…";
  else if (!state.layout) text = "looking at this drive…";
  else if (state.junkOnly) text = "nothing here looks like junk · f to show everything";
  else if (state.scan.phase === "scanning" && state.stack.length === 0) text = "still measuring…";
  else if (id === "system")
    text = IS_MAC
      ? "macOS itself, snapshots, swap and anything this scan could not read. macOS manages it."
      : "the system itself, swap and anything this scan could not read. the system manages it.";
  else if (state.stack.length > 0) text = "empty, or could not be read";
  else if (store.allEntries().length === 0 && state.scan.sizes[id] < 1e6) text = "nothing here";
  else text = "nothing large enough to list";
  return (
    <T fs={fs} color={FAINT} style={{ margin: { top: fs * 0.6, left: ch(fs, 4) }, wrap: true, flexShrink: 1 }}>
      {text}
    </T>
  );
}

function Inside(ctx: Ctx) {
  const { state, store, fs } = ctx;
  const entries = store.entries();
  const all = store.allEntries();
  const max = entries[0]?.size ?? 1;
  const rows = useRef<Array<NodeHandle | null>>([]);
  const selectedItem = entries[state.row];

  useEffect(() => {
    rows.current[state.row]?.scrollIntoView(false);
  }, [state.row, state.selected, state.stack.length]);

  return (
    <Box style={{ flexDirection: "column", flexGrow: 1, flexShrink: 1, minWidth: 0, gap: fs * 0.2 }}>
      <InsideHeader {...ctx} />
      <Box style={{ gap: fs * 0.6, margin: { top: fs * 0.7, bottom: fs * 0.2 }, flexShrink: 0 }}>
        <T fs={fs} color={state.pane === "list" ? MUTED : FAINT} style={{ flexGrow: 1, margin: { left: ch(fs, 2) } }}>
          {`${all.length} ${all.length === 1 ? "item" : "items"}${state.junkOnly ? " labelled junk or unused" : ""}${state.listing ? " · measuring" : ""}`}
        </T>
        <T fs={fs} color={FAINT}>{(IS_WINDOWS ? "modified" : "last used").padStart(10)}</T>
      </Box>
      {entries.length === 0 ? (
        <Empty {...ctx} />
      ) : (
        <Box style={{ flexDirection: "column", flexGrow: 1, flexShrink: 1, overflow: "scroll", scrollbar: { width: 3, thumbColor: "#2a2a2a" } }}>
          {entries.map((item, index) => (
            <Box key={item.path} style={{ flexDirection: "column", flexShrink: 0 }}>
              <ItemLine {...ctx} item={item} index={index} max={max} rowRef={(node) => (rows.current[index] = node)} />
              {index === state.row && selectedItem ? (
                <ItemDetails {...ctx} item={item} index={index} />
              ) : telling(item, state.culprits[item.path]) ? (
                <CulpritLine item={item} culprit={state.culprits[item.path] as Culprit} fs={fs} color={MUTED} category={state.selected} />
              ) : null}
            </Box>
          ))}
          {all.length > MAX_ROWS ? (
            <T fs={fs} color={FAINT} style={{ margin: { top: fs * 0.4, left: fs * 2.4 } }}>{`… and ${all.length - MAX_ROWS} smaller`}</T>
          ) : null}
        </Box>
      )}
    </Box>
  );
}

// ---- bottom line -----------------------------------------------------------------------

function BottomLine({ state, fs }: Ctx) {
  const keys: Array<[string, string]> =
    state.pane === "list"
      ? [["↑↓", "move"], ["→", "open"], ["←", "back"], ["g", "culprit"], ["f", "junk only"], ["o", "reveal"], ["⌫", "remove"], ["q", "quit"]]
      : [["↑↓", "category"], ["→", "look inside"], ["f", "junk only"], ["c", "clear"], ...(state.drives.length > 1 ? [["v", "drive"] as [string, string]] : []), ["r", "rescan"], ["q", "quit"]];
  return (
    <Box style={{ justifyContent: "space-between", gap: fs * 2, flexShrink: 0 }}>
      <Box style={{ gap: fs * 1.4, flexShrink: 0 }}>
        {keys.map(([k, label]) => (
          <Hint key={k} fs={fs} k={k} label={label} color={FAINT} keyColor={MUTED} />
        ))}
      </Box>
      {state.note ? (
        <T fs={fs} color={MUTED} style={{ flexShrink: 1, ellipsis: true }}>{state.note}</T>
      ) : null}
    </Box>
  );
}

// ---- app ------------------------------------------------------------------------------

export function App({ root, store }: { root: Root; store: Store }) {
  const state = useSyncExternalStore(store.subscribe, store.get);
  const info = root.info;
  const cells = info.renderer === "cells";
  const fs = Math.round(info.basePx * 0.85);
  const ctx: Ctx = { state, store, fs };
  const { scan } = state;
  const excess = scan.total > 0 ? scan.measured - scan.used : 0;
  // 1 + 1 + 1 + 12 + 9 characters, the dots, and the gaps between them.
  const left = fs * 0.6 * 24 + fs * 0.6 * 5 + 14 * (Math.max(2, Math.round(fs * 0.26)) + Math.max(1, Math.round(fs * 0.14)));

  return (
    <Box
      style={{
        flexDirection: "column",
        width: "100%",
        height: "100%",
        background: BG,
        padding: { top: fs * 0.8, bottom: fs * 0.8, left: fs * 1.2, right: fs * 1.2 },
        gap: fs * 0.5,
      }}
    >
      <TopLine {...ctx} />
      <Box style={{ height: fs * 0.4, flexShrink: 0 }} />
      <Totals {...ctx} />
      {scan.phase === "scanning" || excess > 0 ? (
        <T fs={fs} color={MUTED}>
          {scan.phase === "scanning" ? `${gb(scan.measured)} measured so far` : `${gb(scan.measured)} measured · ${size(excess)} above filesystem usage`}
        </T>
      ) : null}
      {cells ? <CellMeter state={state} fs={fs} /> : <Meter root={root} store={store} fs={fs} />}
      <Box style={{ flexGrow: 1, flexShrink: 1, gap: fs * 3, margin: { top: fs * 0.8 }, minWidth: 0 }}>
        <Categories {...ctx} width={left} />
        <Inside {...ctx} />
      </Box>
      <BottomLine {...ctx} />
    </Box>
  );
}

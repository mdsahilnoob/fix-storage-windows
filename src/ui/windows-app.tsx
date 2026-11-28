import { basename } from "node:path";
import { useEffect, useState, useSyncExternalStore } from "react";
import { CATEGORIES, CATEGORY, TIER_LABEL, type CategoryId, type Rgb } from "../core/categories";
import { shortAge } from "../core/classify";
import { capacity, gb, size, tilde } from "../core/format";
import type { Recommendation } from "../core/recommendations";
import { unmeasuredBytes, type Item } from "../core/scan";
import { diskSegments } from "./bar";
import type { Store } from "./store";

// Ink is ESM while this package compiles as CommonJS. TypeScript requires an
// explicit import resolution mode for a type-only reference in that case.
export type InkModule = typeof import("ink", { with: { "resolution-mode": "import" } });

export function createWindowsApp(ink: InkModule) {
  const { Box, Text, useInput, useStdout } = ink;

const rgb = (color: Rgb) => `#${color.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
const pct = (part: number, whole: number) => `${whole > 0 ? Math.round((part / whole) * 100) : 0}%`;
const DIM = "#303030";
const FAINT = "#5a5a5a";
const MUTED = "#8c8c8c";

function hash(a: number, b: number): number {
  let h = Math.imul(a + 374761393, 668265263) ^ Math.imul(b + 1274126177, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function statusText(store: Store): { text: string; color: string } {
  const scan = store.get().scan;
  if (scan.phase === "scanning") return { text: `measuring ${tilde(scan.current)}`, color: MUTED };
  if (scan.phase === "cancelled") {
    return { text: `cancelled · partial · ${size(unmeasuredBytes(scan))} unmeasured`, color: "yellow" };
  }
  if (scan.phase === "failed") return { text: `failed · partial${scan.error ? ` · ${scan.error}` : ""}`, color: "red" };
  return { text: "scan complete", color: FAINT };
}

/** One-line character heatmap: the single top storage bar. */
function Heatmap({ store, width }: { store: Store; width: number }) {
  const segments = diskSegments(store.get().scan);
  const cells: Array<{ color: string; kind: "segment" | "unmeasured" | "free" }> = [];

  for (const segment of segments) {
    if (segment.fraction <= 0 || cells.length >= width) continue;
    let count = Math.max(1, Math.round(segment.fraction * width));
    count = Math.min(count, width - cells.length);
    for (let index = 0; index < count; index++) {
      cells.push({
        color: segment.id === "unmeasured" ? "#3a3a3a" : rgb(segment.color as Rgb),
        kind: segment.id === "unmeasured" ? "unmeasured" : "segment",
      });
    }
  }
  while (cells.length < width) cells.push({ color: DIM, kind: "free" });

  return (
    <Box>
      {cells.slice(0, width).map((cell, column) => {
        if (cell.kind === "free") return <Text key={column} color={DIM}> </Text>;
        if (cell.kind === "unmeasured") return <Text key={column} color={cell.color}>░</Text>;
        const noise = hash(column + 1, 7);
        const char = noise > 0.8 ? "█" : noise > 0.42 ? "▓" : "▒";
        return <Text key={column} color={cell.color}>{char}</Text>;
      })}
    </Box>
  );
}

function CategoryList({ store, width }: { store: Store; width: number }) {
  const state = store.get();

  return (
    <Box flexDirection="column" width={width} marginRight={2} flexShrink={0}>
      <Text color={FAINT}>categories</Text>
      {CATEGORIES.map((category) => {
        const selected = state.selected === category.id;
        const focused = selected && state.pane === "sidebar";
        const marker = focused ? "› " : selected ? "· " : "  ";
        const name = category.name.slice(0, 11).padEnd(11);
        return (
          <Box key={category.id}>
            <Text color={selected ? rgb(category.color) : "gray"} bold={selected}>
              {marker}
            </Text>
            <Text color={rgb(category.color)}>■</Text>
            <Text color={selected ? "white" : "gray"} bold={selected}>
              {` ${name}`}
            </Text>
            <Text color={selected ? "white" : MUTED}>{gb(state.scan.sizes[category.id]).padStart(8)}</Text>
          </Box>
        );
      })}
      <Box marginTop={1} flexDirection="column">
        <Text color={TIER_COLOR[CATEGORY[state.selected].tier]}>{TIER_LABEL[CATEGORY[state.selected].tier]}</Text>
        <Text color="green">c review recommendation</Text>
        <Text color={FAINT}>no files will be modified</Text>
      </Box>
    </Box>
  );
}

const TIER_COLOR: Record<string, string> = { safe: "green", review: "yellow", keep: "gray" };

function CategoryStrip({ store }: { store: Store }) {
  const state = store.get();
  const category = CATEGORY[state.selected];
  return (
    <Text wrap="truncate">
      <Text color={rgb(category.color)} bold>■ {category.name}</Text>
      <Text color="white"> {gb(state.scan.sizes[category.id])}</Text>
      <Text color={FAINT}>  ·  ↑↓ category · → list</Text>
    </Text>
  );
}

function ItemRow({
  store,
  item,
  index,
  showPath,
  showDetails,
  showMeta,
  showAge,
}: {
  store: Store;
  item: Item;
  index: number;
  showPath: boolean;
  showDetails: boolean;
  showMeta: boolean;
  showAge: boolean;
}) {
  const state = store.get();
  const selected = state.row === index;
  const focused = selected && state.pane === "list";
  const label = store.label(item);
  const usage = state.usage[item.path];
  const category = CATEGORY[state.selected];
  const color = label.verdict === "review" ? "cyan" : label.verdict === "unused" ? "yellow" : label.verdict === "system" ? "blue" : label.verdict === "junk" ? "green" : "gray";
  const name = basename(item.path) || item.path;

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box>
        <Text color={focused ? rgb(category.color) : "gray"} bold={focused}>
          {focused ? "›" : selected ? "·" : " "}
        </Text>
        <Text color={item.dir ? rgb(category.color) : "gray"}>{item.dir ? " ▸" : "  "}</Text>
        <Box flexGrow={1} flexShrink={1}>
          <Text color={selected ? "white" : "#b5b5b5"} bold={selected} wrap="truncate">
            {name + (item.dir ? "/" : "")}
          </Text>
        </Box>
        <Text color={selected ? "white" : MUTED}>{size(item.size).padStart(8)}</Text>
        {showMeta ? <Text color={color}>{label.verdict === "yours" ? "" : label.verdict.padEnd(7)}</Text> : null}
        {showAge && usage ? <Text color={FAINT}>{shortAge(Date.now() - usage.at).padStart(6)}</Text> : null}
      </Box>
      {selected && showDetails ? (
        <Box flexDirection="column" marginLeft={2}>
          <Text color={color} wrap="truncate">
            {label.verdict === "unused" ? "probably unused" : label.verdict}
            {label.reason ? ` · ${label.reason}` : ""}
          </Text>
          <Text color={FAINT} wrap="truncate">
            {showPath ? tilde(item.path) : basename(item.path)}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

function SectionHeader({
  store,
  compact,
  visibleCount,
  start,
  total,
}: {
  store: Store;
  compact: boolean;
  visibleCount: number;
  start: number;
  total: number;
}) {
  const state = store.get();
  const category = CATEGORY[state.selected];
  const all = store.allEntries().length;
  const scope = state.stack.length ? tilde(state.stack[state.stack.length - 1].path) : category.blurb;
  const range = total > visibleCount ? ` · ${start + 1}–${Math.min(total, start + visibleCount)} of ${total}` : "";
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box>
        <Text bold color={rgb(category.color)}>{category.name}</Text>
        <Text color="white"> · {gb(store.scopeSize())}</Text>
        {state.listing ? <Text color="yellow"> · measuring</Text> : null}
      </Box>
      {!compact ? <Text color={FAINT} wrap="truncate">{scope}</Text> : null}
      <Text color={FAINT} wrap="truncate">
        {`${all} ${all === 1 ? "item" : "items"}${state.junkOnly ? " · junk/unused only" : ""}${range}`}
      </Text>
    </Box>
  );
}

function RecommendationPanel({ recommendation, compact }: { recommendation: Recommendation; compact: boolean }) {
  if (compact) {
    return (
      <Text color="green" wrap="truncate">
        {recommendation.title} · {size(recommendation.estimatedBytes)} measured for review
      </Text>
    );
  }
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text color="green" bold wrap="truncate">{recommendation.title}</Text>
      <Text color={MUTED} wrap="truncate">
        {size(recommendation.estimatedBytes)} measured storage to review · {CATEGORY[recommendation.category].name} · {recommendation.reason}
      </Text>
      <Text color={FAINT} wrap="truncate">Informational only. Review these paths yourself outside the application.</Text>
      {recommendation.paths[0] ? (
        <Text color={FAINT} wrap="truncate">
          {recommendation.paths[0]}{recommendation.paths.length > 1 ? ` · and ${recommendation.paths.length - 1} more paths` : ""}
        </Text>
      ) : null}
      {recommendation.duplicateGroups?.length ? (
        <Text color={MUTED} wrap="truncate">
          {`${recommendation.duplicateGroups.length} possible duplicate groups · contents not compared · conditional logical size only`}
        </Text>
      ) : null}
    </Box>
  );
}

function TerminalApp({ store, onQuit }: { store: Store; onQuit: () => void }) {
  const state = useSyncExternalStore(store.subscribe, store.get);
  const { stdout } = useStdout();
  const [dims, setDims] = useState(() => ({
    columns: stdout?.columns || process.stdout.columns || 80,
    rows: stdout?.rows || process.stdout.rows || 24,
  }));

  useEffect(() => {
    if (!stdout) return;
    const update = () => setDims({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on("resize", update);
    return () => {
      stdout.off("resize", update);
    };
  }, [stdout]);

  const columns = Math.max(20, dims.columns);
  const rows = Math.max(8, dims.rows);
  // Leave breathing room at the bottom. A frame that exactly fills the
  // terminal scrolls, leaving the previous frame behind as a duplicate.
  const contentRows = Math.max(4, rows - 2);
  const narrow = columns < 78;
  const tiny = rows < 12;
  const compact = rows < 24 || narrow;

  const entries = store.entries();
  const selected = entries[state.row];
  // The full category sidebar is 14 lines. Below 22 rows it would force the
  // whole frame past the terminal height, so use the compact strip instead.
  const showSidebar = !narrow && rows >= 22;
  const sideWidth = showSidebar ? Math.min(31, Math.max(26, Math.floor(columns * 0.3))) : 0;
  const contentWidth = Math.max(18, columns - 2 - (showSidebar ? sideWidth + 2 : 0));
  const showMeter = rows >= 14;
  const showReadOnly = rows >= 11 && !tiny;
  const showRecommendation = !!state.recommendation && rows >= 18;
  const recommendationCompact = rows < 28 || narrow;
  const showDetails = !!selected && rows >= 17 && !showRecommendation;
  const detailsRows = showDetails ? 2 : 0;
  const headerRows = tiny ? 2 : 3 + (showReadOnly ? 1 : 0) + (columns < 50 ? 1 : 0);
  const sectionRows = tiny ? 2 : !showSidebar ? 3 : compact ? 2 : 3;
  const recommendationRows = showRecommendation ? (recommendationCompact ? 1 : 5) : 0;
  const footerRows = 1 + (state.note ? 1 : 0) + (state.action ? 1 : 0);
  const visibleCount = Math.max(1, contentRows - headerRows - (showMeter ? 1 : 0) - sectionRows - recommendationRows - detailsRows - footerRows);
  const start = Math.max(0, Math.min(Math.max(0, entries.length - visibleCount), state.row - Math.floor(visibleCount / 2)));
  const visible = entries.slice(start, start + visibleCount);
  const status = statusText(store);
  const drive = state.drives[state.drive];
  const reclaimable = store.reclaimable();
  const showMeta = contentWidth >= 44;
  const showAge = contentWidth >= 58;
  const narrowFooter = columns < 70;
  const footer = state.pane === "list"
    ? narrowFooter
      ? "↑↓ move · Enter open · ← back · c review · q quit"
      : "↑↓ move · PgUp/PgDn page · Enter open · ← back · g culprit · f filter · c recommend · q quit"
    : narrowFooter
      ? "↑↓ category · Enter list · c review · q quit"
      : "↑↓ category · Enter list · f filter · c recommend · v drive · r rescan · q quit";

  useInput((input, key) => {
    if (key.ctrl && input === "c") return onQuit();
    if (key.ctrl || key.meta) return;
    if (input === "q") return onQuit();
    if (input === "r") return store.rescan();
    if (input === "f") return store.toggleJunkOnly();
    if (input.toLowerCase() === "v") return store.nextDrive(key.shift || input === "V" ? -1 : 1);
    if (/^[1-9]$/.test(input)) {
      const index = Number(input) - 1;
      if (index < state.drives.length) store.setDrive(index);
      return;
    }
    if (input === "c") {
      if (state.pane === "list" && state.stack.length === 0) return store.reviewItem();
      const suggestion = store.suggestion();
      if (suggestion) void store.reviewCategory(suggestion);
      return;
    }
    if (state.pane === "sidebar") {
      if (key.upArrow || input === "k") return store.moveCategory(-1);
      if (key.downArrow || input === "j") return store.moveCategory(1);
      if (key.rightArrow || key.return || key.tab || input === "l") return store.setPane("list");
      return;
    }
    if (key.upArrow || input === "k") return store.moveRow(-1);
    if (key.downArrow || input === "j") return store.moveRow(1);
    if (key.pageUp) return store.moveRow(-Math.max(1, visibleCount - 1));
    if (key.pageDown) return store.moveRow(Math.max(1, visibleCount - 1));
    if (key.rightArrow || key.return || input === "l") return store.open();
    if (key.leftArrow || key.escape || input === "h") return store.back();
    if (key.tab) return store.setPane("sidebar");
    if (input === "g") return store.goToCulprit();
    if (input === "o" || input === " ") return void store.reveal();
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold wrap="truncate">
          {tiny ? "fix-storage · " : "fix-storage "}
          <Text color="cyan">Windows</Text>
          {store.options.demo ? " · demo" : ""}
          {tiny ? ` · ${status.text}` : ""}
        </Text>
        {!tiny && columns >= 50 ? <Text color={status.color} wrap="truncate">{status.text}</Text> : null}
      </Box>
      {!tiny && columns < 50 ? <Text color={status.color} wrap="truncate">{status.text}</Text> : null}
      {showReadOnly ? <Text color="green" bold wrap="truncate">{narrow ? "READ-ONLY · NO MODIFICATIONS" : "READ-ONLY MODE — NO FILES WILL BE MODIFIED"}</Text> : null}
      <Box justifyContent="space-between">
        <Text wrap="truncate">
          {gb(state.scan.used)} used of {capacity(state.scan.total)} · {gb(state.scan.available)} free · {pct(state.scan.used, state.scan.total)} full
        </Text>
        {columns >= 92 ? (
          <Text color="green" wrap="truncate">{`${size(reclaimable.junk + reclaimable.unused)} potentially recoverable · estimate only`}</Text>
        ) : null}
      </Box>
      {!tiny ? (
        <Text color={FAINT} wrap="truncate">
          {drive
            ? [drive.name, drive.fstype, drive.driveType, drive.label, drive.mount, drive.readOnly ? "read-only" : "", state.layout?.lookOnly ? "look only" : ""]
                .filter(Boolean)
                .join(" · ")
            : "no accessible drive"}
        </Text>
      ) : null}
      {showMeter ? <Heatmap store={store} width={Math.max(10, columns - 2)} /> : null}
      {showSidebar ? (
        <Box flexGrow={1} flexShrink={1}>
          <CategoryList store={store} width={sideWidth} />
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <SectionHeader store={store} compact={compact} visibleCount={visibleCount} start={start} total={entries.length} />
            {visible.map((item, offset) => (
              <ItemRow key={item.path} store={store} item={item} index={start + offset} showPath={!narrow} showDetails={showDetails} showMeta={showMeta} showAge={showAge} />
            ))}
            {entries.length === 0 ? (
              <Text color={FAINT}>{state.scan.phase === "scanning" ? "still measuring…" : state.scan.phase === "completed" ? "nothing here" : "partial analysis; nothing measured here"}</Text>
            ) : null}
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {!tiny ? <CategoryStrip store={store} /> : null}
          <SectionHeader store={store} compact visibleCount={visibleCount} start={start} total={entries.length} />
          {visible.map((item, offset) => (
            <ItemRow key={item.path} store={store} item={item} index={start + offset} showPath={false} showDetails={showDetails} showMeta={showMeta} showAge={showAge} />
          ))}
          {entries.length === 0 ? (
            <Text color={FAINT}>{state.scan.phase === "scanning" ? "still measuring…" : state.scan.phase === "completed" ? "nothing here" : "partial analysis; nothing measured here"}</Text>
          ) : null}
        </Box>
      )}
      {showRecommendation && state.recommendation ? (
        <RecommendationPanel recommendation={state.recommendation} compact={recommendationCompact} />
      ) : null}
      {state.action ? <Text color="yellow" wrap="truncate">analyzing {CATEGORY[state.action.id].name}: {tilde(state.action.current)}</Text> : null}
      {state.note && rows >= 12 ? <Text color="cyan" wrap="truncate">{state.note}</Text> : null}
      <Text color={FAINT} wrap="truncate">{footer}</Text>
    </Box>
  );
}

  return function WindowsApp(props: { store: Store; onQuit: () => void }) {
    return <TerminalApp {...props} />;
  };
}

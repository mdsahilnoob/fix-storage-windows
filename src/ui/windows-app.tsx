import { basename } from "node:path";
import { useSyncExternalStore } from "react";
import { CATEGORIES, CATEGORY, TIER_LABEL, type CategoryId, type Rgb } from "../core/categories";
import { shortAge } from "../core/classify";
import { capacity, gb, size, tilde } from "../core/format";
import type { Recommendation } from "../core/recommendations";
import type { Item } from "../core/scan";
import { diskSegments } from "./bar";
import type { Store } from "./store";

// Ink is ESM while this package compiles as CommonJS. TypeScript requires an
// explicit import resolution mode for a type-only reference in that case.
export type InkModule = typeof import("ink", { with: { "resolution-mode": "import" } });

const rgb = (color: Rgb) => `#${color.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
const pct = (part: number, whole: number) => `${whole > 0 ? Math.round((part / whole) * 100) : 0}%`;

/** Read-only Ink renderer backed by the analysis store. */
export function createWindowsApp(ink: InkModule) {
  const { Box, Text, useInput } = ink;

  function Meter({ store }: { store: Store }) {
    const state = store.get();
    const segments = diskSegments(state.scan);
    const width = 64;
    let used = 0;
    const columns = segments.map((segment) => {
      const count = Math.min(width - used, Math.round(segment.fraction * width));
      used += Math.max(0, count);
      return { ...segment, count: Math.max(0, count) };
    });
    return (
      <Box>
        <Text color="gray">[</Text>
        {columns.map((segment) => (
          <Text key={segment.id} color={rgb(segment.color as Rgb)}>{"█".repeat(segment.count)}</Text>
        ))}
        <Text color="gray">{"░".repeat(Math.max(0, width - used))}]</Text>
      </Box>
    );
  }

  const TIER_COLOR: Record<string, string> = { safe: "green", review: "yellow", keep: "gray" };

  function CategoryList({ store }: { store: Store }) {
    const state = store.get();
    return (
      <Box flexDirection="column" width={29} marginRight={2}>
        <Text dimColor>categories</Text>
        {CATEGORIES.map((category) => {
          const selected = state.selected === category.id;
          return (
            <Box key={category.id} justifyContent="space-between">
              <Text color={selected ? rgb(category.color) : "gray"} bold={selected}>
                {selected && state.pane === "sidebar" ? "› " : "  "}{category.name.padEnd(13)}
              </Text>
              <Text color={selected ? "white" : "gray"}>{gb(state.scan.sizes[category.id])}</Text>
            </Box>
          );
        })}
        <Box marginTop={1} flexDirection="column">
          <Text color={TIER_COLOR[CATEGORY[state.selected].tier]}>{TIER_LABEL[CATEGORY[state.selected].tier]}</Text>
          <Text color="green">c  review recommendation</Text>
          <Text dimColor>no files will be modified</Text>
        </Box>
      </Box>
    );
  }

  function ItemRow({ store, item, index }: { store: Store; item: Item; index: number }) {
    const state = store.get();
    const selected = state.row === index;
    const label = store.label(item);
    const usage = state.usage[item.path];
    const color = label.verdict === "junk" ? "green" : label.verdict === "unused" ? "yellow" : label.verdict === "system" ? "blue" : "gray";
    return (
      <Box flexDirection="column">
        <Text color={selected ? "white" : "gray"} bold={selected} wrap="truncate">
          {selected && state.pane === "list" ? "›" : " "}{item.dir ? "▸" : " "}{basename(item.path) || item.path}{item.dir ? "/" : ""}  {size(item.size).padStart(8)}  <Text color={color}>{label.verdict === "yours" ? "" : label.verdict.padEnd(6)}</Text>  {usage ? shortAge(Date.now() - usage.at) : ""}
        </Text>
        {selected ? (
          <Box flexDirection="column" marginLeft={3}>
            {label.reason ? <Text color={color} wrap="truncate">{label.verdict} · {label.reason}</Text> : null}
            {item.dir && state.culprits[item.path] === "pending" ? <Text dimColor>finding what takes the space…</Text> : null}
            {item.dir && state.culprits[item.path] && state.culprits[item.path] !== "pending" && (state.culprits[item.path] as { chain: Item[] }).chain.length > 0 ? (
              <Text dimColor wrap="truncate">mostly in {((state.culprits[item.path] as { chain: Item[] }).chain.at(-1) as Item).path}</Text>
            ) : null}
            <Text dimColor wrap="truncate">{tilde(item.path)}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  function RecommendationPanel({ recommendation }: { recommendation: Recommendation | null }) {
    if (!recommendation) return null;
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1} marginTop={1}>
        <Text color="green" bold>{recommendation.title}</Text>
        <Text>{size(recommendation.estimatedBytes)} estimated cleanup opportunity · {CATEGORY[recommendation.category].name}</Text>
        <Text wrap="truncate">{recommendation.reason}</Text>
        <Text dimColor>Informational only. Review these paths yourself outside the application.</Text>
        {recommendation.paths.slice(0, 4).map((path) => <Text key={path} wrap="truncate">  {path}</Text>)}
        {recommendation.paths.length > 4 ? <Text dimColor>  … and {recommendation.paths.length - 4} more</Text> : null}
      </Box>
    );
  }

  function WindowsApp({ store, onQuit }: { store: Store; onQuit: () => void }) {
    const state = useSyncExternalStore(store.subscribe, store.get);
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
        if (suggestion) return void store.reviewCategory(suggestion);
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
      if (key.pageUp) return store.moveRow(-10);
      if (key.pageDown) return store.moveRow(10);
      if (key.rightArrow || key.return || input === "l") return store.open();
      if (key.leftArrow || key.escape || input === "h") return store.back();
      if (key.tab) return store.setPane("sidebar");
      if (input === "g") return store.goToCulprit();
      if (input === "o" || input === " ") return void store.reveal();
    });

    const entries = store.entries();
    const visibleCount = 24;
    const start = Math.max(0, Math.min(entries.length - visibleCount, state.row - Math.floor(visibleCount / 2)));
    const visible = entries.slice(start, start + visibleCount);
    const selected = entries[state.row];
    const drive = state.drives[state.drive];
    const limit = selected ? store.reviewLimit(selected) : null;

    return (
      <Box flexDirection="column" paddingX={1} paddingY={0}>
        <Box justifyContent="space-between">
          <Text bold>fix-storage <Text color="cyan">Windows</Text>{store.options.demo ? " · demo" : ""}</Text>
          <Text color="yellow" bold>READ-ONLY MODE — NO FILES WILL BE MODIFIED</Text>
        </Box>
        <Text dimColor>{state.scan.phase === "scanning" ? `measuring ${tilde(state.scan.current)}` : "analysis complete"}</Text>
        <Text color="cyan" wrap="truncate">{state.drives.map((item, index) => `${index === state.drive ? "[" : ""}${index + 1}:${item.name}${index === state.drive ? "]" : ""}`).join("  ")}</Text>
        <Text>{gb(state.scan.used)} used of {capacity(state.scan.total)} · {gb(state.scan.available)} free · {pct(state.scan.used, state.scan.total)} full</Text>
        <Text dimColor>{`estimated category sizes: ${gb(state.scan.measured)} measured · ${size(state.reclaimable().junk + state.reclaimable().unused)} potentially recoverable (estimates may overlap)`}</Text>
        {drive ? <Text dimColor wrap="truncate">{[drive.fstype, drive.driveType, drive.label, drive.mount, drive.readOnly ? "read-only" : ""].filter(Boolean).join(" · ")}</Text> : null}
        <Meter store={store} />
        <Box flexGrow={1} marginTop={1}>
          <CategoryList store={store} />
          <Box flexDirection="column" flexGrow={1}>
            <Text bold color={rgb(CATEGORY[state.selected].color)}>{CATEGORY[state.selected].name} · {gb(store.scopeSize())}</Text>
            <Text dimColor wrap="truncate">{state.stack.length ? tilde(state.stack[state.stack.length - 1].path) : CATEGORY[state.selected].blurb}</Text>
            <Text dimColor>{store.allEntries().length} items · modified time (not last-opened time) · f: {state.junkOnly ? "show all" : "junk only"}</Text>
            {state.layout?.lookOnly ? <Text color="yellow">{state.layout.lookOnly}</Text> : null}
            {visible.map((item, offset) => <ItemRow key={item.path} store={store} item={item} index={start + offset} />)}
            {entries.length === 0 ? <Text dimColor>{state.scan.phase === "scanning" ? "still measuring…" : "nothing here"}</Text> : null}
            {entries.length > visibleCount ? <Text dimColor>showing {start + 1}–{Math.min(entries.length, start + visibleCount)} of {entries.length}; selection scrolls with ↑/↓</Text> : null}
            {selected ? (
              <Box marginTop={1} flexDirection="column">
                <Text color={limit ? "gray" : "green"}>{limit ?? `c: review ${basename(selected.path)} · ${size(selected.size)} estimated opportunity`}</Text>
                <Text dimColor>Enter: open · g: culprit · o/Space: Explorer · c: recommendation · Tab: panes</Text>
              </Box>
            ) : null}
          </Box>
        </Box>
        <RecommendationPanel recommendation={state.recommendation} />
        {state.action ? <Text color="yellow">analyzing {CATEGORY[state.action.id].name}: {tilde(state.action.current)}</Text> : null}
        {state.note ? <Text color="cyan">{state.note}</Text> : null}
        <Text dimColor>↑↓/j/k move · Enter open · ←/Esc back · f filter · c recommendation · v/1–9 drives · r rescan · q quit</Text>
      </Box>
    );
  }

  return WindowsApp;
}

import { basename } from "node:path";
import { useSyncExternalStore } from "react";
import { CATEGORIES, CATEGORY, TIER_LABEL, type CategoryId, type Rgb } from "../core/categories";
import { shortAge } from "../core/classify";
import { capacity, gb, size, tilde } from "../core/format";
import { TRASH_NAME } from "../core/platform";
import type { Item } from "../core/scan";
import { diskSegments } from "./bar";
import type { Store } from "./store";

export type InkModule = typeof import("ink");

const rgb = (color: Rgb) => `#${color.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
const pct = (part: number, whole: number) => `${whole > 0 ? Math.round((part / whole) * 100) : 0}%`;

/** A native cell renderer for Windows, backed by the original application store. */
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
          {store.canClear("caches") ? <Text color="green">c  prepare cache cleanup</Text> : null}
          <Text dimColor>Recycle Bin is never emptied</Text>
        </Box>
      </Box>
    );
  }

  const TIER_COLOR: Record<string, string> = { safe: "green", review: "yellow", keep: "gray" };

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

  function Confirmation({ store }: { store: Store }) {
    const confirm = store.get().confirm;
    if (!confirm) return null;
    const paths = confirm.paths ?? [confirm.kind === "item" ? confirm.path : ""];
    const bytes = confirm.bytes ?? 0;
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
        <Text color="yellow" bold>Confirm {TRASH_NAME} move</Text>
        <Text>{paths.length} selected {paths.length === 1 ? "item" : "items"} · estimated {size(bytes)}</Text>
        <Text color={store.pretend ? "cyan" : "yellow"}>
          {store.pretend ? "DRY RUN: filesystem contents will not change." : `Items will be moved to the ${TRASH_NAME}; they can be restored there.`}
        </Text>
        <Text bold>Exact selected paths:</Text>
        {paths.map((path) => <Text key={path}>  {path}</Text>) }
        <Text color="yellow" bold>{confirm.kind === "item" ? "Press d/Delete again" : "Press c again"} within 15 seconds to confirm. Any navigation cancels.</Text>
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

      if (state.pane === "sidebar") {
        if (key.upArrow || input === "k") return store.moveCategory(-1);
        if (key.downArrow || input === "j") return store.moveCategory(1);
        if (key.rightArrow || key.return || key.tab || input === "l") return store.setPane("list");
        if (input === "c") {
          if (store.canClear(state.selected)) store.press(state.selected);
          else {
            const suggestion = store.suggestion();
            if (suggestion) store.press(suggestion);
          }
        }
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
      if (key.backspace || key.delete || input === "d") return store.removeItem();
      if (input === "c" && state.stack.length === 0 && store.canClear(state.selected)) return store.press(state.selected);
    });

    const entries = store.entries();
    const visibleCount = 24;
    const start = Math.max(0, Math.min(entries.length - visibleCount, state.row - Math.floor(visibleCount / 2)));
    const visible = entries.slice(start, start + visibleCount);
    const selected = entries[state.row];
    const drive = state.drives[state.drive];
    const blocked = selected ? store.blocked(selected) : null;
    const confirm = state.confirm;
    const paths = confirm?.paths ?? [];

    return (
      <Box flexDirection="column" paddingX={1} paddingY={0}>
        <Box justifyContent="space-between">
          <Text bold>fix-storage <Text color="cyan">Windows</Text>{store.options.demo ? " · demo" : store.options.dryRun ? " · dry run" : ""}</Text>
          <Text dimColor>{state.scan.phase === "scanning" ? `measuring ${tilde(state.scan.current)}` : "scan complete"}</Text>
        </Box>
        <Text color="cyan" wrap="truncate">{state.drives.map((item, index) => `${index === state.drive ? "[" : ""}${index + 1}:${item.name}${index === state.drive ? "]" : ""}`).join("  ")}</Text>
        <Text>{gb(state.scan.used)} used of {capacity(state.scan.total)} · {gb(state.scan.available)} free · {pct(state.scan.used, state.scan.total)} full</Text>
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
            {selected && !confirm ? (
              <Box marginTop={1} flexDirection="column">
                <Text color={blocked ? "gray" : "yellow"}>{blocked ?? `d/Delete: select 1 item · ${size(selected.size)} · ${TRASH_NAME}`}</Text>
                <Text dimColor>Enter: open · g: culprit · o/Space: Explorer · d: recycle · c: cache cleanup · Tab: panes</Text>
              </Box>
            ) : null}
          </Box>
        </Box>
        <Confirmation store={store} />
        {state.action ? <Text color="yellow">moving to {TRASH_NAME}: {tilde(state.action.current)}</Text> : null}
        {state.removing ? <Text color="yellow">moving {tilde(state.removing)} to {TRASH_NAME}…</Text> : null}
        {state.note ? <Text color="cyan">{state.note}</Text> : null}
        <Text dimColor>↑↓/j/k move · Enter open · ←/Esc back · f filter · v/1–9 drives · r rescan · q quit</Text>
        {confirm && paths.length > 0 ? <Text dimColor>Confirmation lists all {paths.length} exact paths above.</Text> : null}
      </Box>
    );
  }

  return WindowsApp;
}

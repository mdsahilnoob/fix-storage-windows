import { createRoot } from "@zenbu-labs/pixel";
import { driveArg } from "./plain";
import { App } from "./ui/app";
import { Store } from "./ui/store";

const argv = process.argv.slice(2);
const args = new Set(argv);
const store = new Store({ demo: args.has("--demo"), dryRun: args.has("--dry-run"), drive: driveArg(argv) });

const quit = () => {
  store.stop();
  root.stop();
};

/** Keys while the category list on the left has focus. */
function sidebarKey(key: string): boolean {
  const { selected } = store.get();
  switch (key) {
    case "up":
    case "k":
      return store.moveCategory(-1), true;
    case "down":
    case "j":
      return store.moveCategory(1), true;
    case "right":
    case "l":
    case "enter":
    case "tab":
      return store.setPane("list"), true;
    case "c":
      if (store.canClear(selected)) store.press(selected);
      else {
        const id = store.suggestion();
        if (id) store.press(id);
      }
      return true;
  }
  return false;
}

/** Keys while the item list on the right has focus. */
function listKey(key: string): boolean {
  const { selected } = store.get();
  switch (key) {
    case "up":
    case "k":
      return store.moveRow(-1), true;
    case "down":
    case "j":
      return store.moveRow(1), true;
    case "pageup":
      return store.moveRow(-10), true;
    case "pagedown":
      return store.moveRow(10), true;
    case "home":
      return store.moveRow(-Infinity), true;
    case "end":
      return store.moveRow(Infinity), true;
    case "right":
    case "l":
    case "enter":
      return store.open(), true;
    case "left":
    case "h":
    case "escape":
      return store.back(), true;
    case "tab":
      return store.setPane("sidebar"), true;
    case "g":
      return store.goToCulprit(), true;
    case "o":
    case "space":
      return void store.reveal(), true;
    case "backspace":
    case "delete":
    case "d":
      return store.removeItem(), true;
    case "c":
      if (store.get().stack.length === 0 && store.canClear(selected)) store.press(selected);
      return true;
  }
  return false;
}

const root = createRoot({
  name: "fix-storage",
  onKey(event) {
    if (event.kind === "release") return;
    const { key, mods } = event;
    if (mods.ctrl && key === "c") return quit(), true;
    if (mods.ctrl || mods.alt || mods.super) return;
    if (key === "q") return quit(), true;
    if (key === "r") return store.rescan(), true;
    if (key === "f") return store.toggleJunkOnly(), true;
    if (key === "v" || key === "V") return store.nextDrive(mods.shift || key === "V" ? -1 : 1), true;
    if (/^[1-9]$/.test(key)) {
      const index = Number(key) - 1;
      if (index < store.get().drives.length) store.setDrive(index);
      return true;
    }
    const handled = store.get().pane === "sidebar" ? sidebarKey(key) : listKey(key);
    return handled || undefined;
  },
  onResize() {
    render();
  },
});

function render() {
  root.render(<App root={root} store={store} />);
}

root.setTitle("fix-storage");
render();
store.rescan();

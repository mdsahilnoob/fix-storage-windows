import { createElement } from "react";
import { driveArg } from "./plain";
import { Store } from "./ui/store";
import { createWindowsApp, type InkModule } from "./ui/windows-app";

// Ink is ESM. Native dynamic import keeps the rest of the original CommonJS
// package and launcher unchanged.
const importModule = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<InkModule>;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  const store = new Store({ demo: args.has("--demo"), dryRun: args.has("--dry-run"), drive: driveArg(argv) });
  const ink = await importModule("ink");
  const App = createWindowsApp(ink);
  const view = ink.render(createElement(App, { store, onQuit: () => view.unmount() }), { exitOnCtrlC: false });
  store.rescan();
  try {
    await view.waitUntilExit();
  } finally {
    store.stop();
  }
}

void main().catch((error) => {
  process.stderr.write(`fix-storage: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

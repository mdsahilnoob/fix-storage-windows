/**
 * Development-only scanner selection. TypeScript is always the default and
 * Rust is only available on Windows with an explicit executable.
 */
export type ScannerEngine = "typescript" | "rust";

export const RUST_SCANNER_EXECUTABLE_ENV = "FIX_STORAGE_RUST_SCANNER";

export function selectScannerEngine(value: string | undefined, platform: string = process.platform): ScannerEngine {
  if (value === undefined || value === "" || value === "typescript") return "typescript";
  if (value === "rust") {
    if (platform !== "win32") {
      throw new Error("the Rust scanner is only available on Windows; TypeScript is required on this platform");
    }
    return "rust";
  }
  throw new Error(`unsupported scanner "${value}"; use "typescript" or "rust"`);
}

/** Read `--scanner x` or `--scanner=x` without accepting positional values. */
export function scannerArg(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--scanner") return args[index + 1];
    if (args[index].startsWith("--scanner=")) return args[index].slice("--scanner=".length);
  }
  return undefined;
}

export function rustScannerExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[RUST_SCANNER_EXECUTABLE_ENV];
  return value && value.trim() ? value : undefined;
}

export function rustScannerPathArg(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--scanner-rust-path") return args[index + 1];
    if (args[index].startsWith("--scanner-rust-path=")) return args[index].slice("--scanner-rust-path=".length);
  }
  return undefined;
}

import { expect, test } from "bun:test";
import {
  RUST_SCANNER_EXECUTABLE_ENV,
  rustScannerExecutable,
  rustScannerPathArg,
  scannerArg,
  selectScannerEngine,
} from "../src/core/scanner-selection";

test("TypeScript is the default scanner selection", () => {
  expect(selectScannerEngine(undefined)).toBe("typescript");
  expect(selectScannerEngine("typescript")).toBe("typescript");
  expect(selectScannerEngine("")).toBe("typescript");
});

test("Rust selection is explicit and Windows-only", () => {
  expect(selectScannerEngine("rust", "win32")).toBe("rust");
  expect(() => selectScannerEngine("rust", "linux")).toThrow("only available on Windows");
  expect(() => selectScannerEngine("bogus", "win32")).toThrow("unsupported scanner");
});

test("scanner arguments are parsed without positional ambiguity", () => {
  expect(scannerArg(["--scanner", "rust"])).toBe("rust");
  expect(scannerArg(["--scanner=typescript"])).toBe("typescript");
  expect(scannerArg(["--drive", "C:", "scanner"])).toBeUndefined();
  expect(rustScannerPathArg(["--scanner-rust-path", "C:\\scanner.exe"])).toBe("C:\\scanner.exe");
  expect(rustScannerPathArg(["--scanner-rust-path=C:\\scanner.exe"])).toBe("C:\\scanner.exe");
});

test("Rust executable environment is explicit and empty values are ignored", () => {
  expect(rustScannerExecutable({})).toBeUndefined();
  expect(rustScannerExecutable({ [RUST_SCANNER_EXECUTABLE_ENV]: "  " })).toBeUndefined();
  expect(rustScannerExecutable({ [RUST_SCANNER_EXECUTABLE_ENV]: "C:\\scanner.exe" })).toBe("C:\\scanner.exe");
  expect(rustScannerPathArg([])).toBeUndefined();
});

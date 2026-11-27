import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const bin = join(import.meta.dir, "..", "bin", "fix-storage.cjs");
const runs: Array<ReturnType<typeof spawnSync>> = [];

function run(args: string[]) {
  const result = spawnSync(process.env.NODE_BINARY ?? "node", [bin, ...args], { encoding: "utf8" });
  runs.push(result);
  return result;
}

afterEach(() => {
  runs.length = 0;
});

const cleanupForms: string[][] = [
  ["--clean"],
  ["--delete"],
  ["--remove"],
  ["--recycle"],
  ["--apply"],
  ["--execute"],
  ["--dry-run"],
  ["--empty-trash"],
  ["--help", "--delete"],
  ["--json", "--clean"],
  ["--drive", "C:", "--remove"],
  ["--clean=value"],
];

test("every cleanup form is rejected with exit code 2 before other work", () => {
  for (const args of cleanupForms) {
    const result = run(args);
    expect({ args, status: result.status, stderr: String(result.stderr) }).toMatchObject({
      args,
      status: 2,
      stderr: expect.stringContaining("automated cleanup is not supported in v1"),
    });
    expect(result.stdout).toBe("");
  }
});

test("cleanup rejection is not masked by help", () => {
  const result = run(["--help", "--delete"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("READ-ONLY");
});

test("help alone still exits successfully and describes read-only mode", () => {
  const result = run(["--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("READ-ONLY storage analysis");
  expect(result.stdout).toContain("No files are deleted");
});

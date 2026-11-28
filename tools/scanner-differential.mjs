#!/usr/bin/env node
"use strict";

import { readFileSync } from "node:fs";

function usage() {
  console.error("Usage: node tools/scanner-differential.mjs --reference <json> --candidate <json>");
  process.exit(2);
}

const args = process.argv.slice(2);
let referenceFile = "";
let candidateFile = "";
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--reference") referenceFile = args[++index] ?? "";
  else if (args[index] === "--candidate") candidateFile = args[++index] ?? "";
  else usage();
}
if (!referenceFile || !candidateFile) usage();

function pathKey(value) {
  return String(value ?? "")
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/i, "")
    .replace(/[\\/]+/g, "\\")
    .replace(/\\$/, "")
    .toLowerCase();
}

function entryKey(entry) {
  return `${pathKey(entry.pathKey ?? entry.displayPath)}|${entry.category ?? ""}`;
}

function normalize(report) {
  if (!report || report.schemaVersion !== "1.0") {
    throw new Error("Both inputs must use schemaVersion 1.0");
  }
  const entries = (Array.isArray(report.entries) ? report.entries : [])
    .map((entry) => ({
      pathKey: pathKey(entry.pathKey ?? entry.displayPath),
      type: entry.type,
      logicalBytes: entry.logicalBytes,
      category: entry.category,
    }))
    .sort((left, right) => entryKey(left).localeCompare(entryKey(right)));
  const errors = (Array.isArray(report.errors) ? report.errors : [])
    .map((error) => ({
      pathKey: pathKey(error.pathKey ?? error.displayPath),
      kind: error.kind,
    }))
    .sort((left, right) => `${left.pathKey}|${left.kind}`.localeCompare(`${right.pathKey}|${right.kind}`));
  return {
    schemaVersion: report.schemaVersion,
    scan: {
      phase: report.scan?.phase,
      partial: report.scan?.partial,
      error: report.scan?.error ?? null,
    },
    volume: {
      id: report.volume?.id ?? null,
      mount: pathKey(report.volume?.mount),
      totalBytes: report.volume?.totalBytes ?? null,
      usedBytes: report.volume?.usedBytes ?? null,
      availableBytes: report.volume?.availableBytes ?? null,
    },
    totals: {
      measuredBytes: report.totals?.measuredBytes ?? null,
      unmeasuredBytes: report.totals?.unmeasuredBytes ?? null,
      categoryBytes: report.totals?.categoryBytes ?? {},
      fileEntries: report.totals?.fileEntries ?? null,
      directoryEntries: report.totals?.directoryEntries ?? null,
      errorCount: report.totals?.errorCount ?? null,
    },
    entries,
    errors,
  };
}

function differences(left, right, path = "", output = []) {
  if (Object.is(left, right)) return output;
  if (typeof left !== typeof right || left === null || right === null) {
    output.push(`${path || "<root>"}: ${JSON.stringify(left)} !== ${JSON.stringify(right)}`);
    return output;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      output.push(`${path}: array mismatch`);
      return output;
    }
    if (left.length !== right.length) output.push(`${path}.length: ${left.length} !== ${right.length}`);
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index++) {
      if (index >= left.length || index >= right.length) continue;
      differences(left[index], right[index], `${path}[${index}]`, output);
    }
    return output;
  }
  if (typeof left === "object") {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of [...keys].sort()) differences(left[key], right[key], path ? `${path}.${key}` : key, output);
    return output;
  }
  output.push(`${path || "<root>"}: ${JSON.stringify(left)} !== ${JSON.stringify(right)}`);
  return output;
}

let reference;
let candidate;
try {
  reference = normalize(JSON.parse(readFileSync(referenceFile, "utf8")));
  candidate = normalize(JSON.parse(readFileSync(candidateFile, "utf8")));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const mismatches = differences(reference, candidate);
if (mismatches.length > 0) {
  console.error(`Scanner differential failed with ${mismatches.length} difference(s):`);
  for (const mismatch of mismatches) console.error(`  ${mismatch}`);
  process.exit(1);
}

console.log("Scanner differential passed: normalized results match.");

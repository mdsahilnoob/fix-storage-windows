import { basename } from "node:path";
import type { CategoryId } from "./categories";
import type { Label, Verdict } from "./classify";
import type { Item } from "./scan";

/**
 * v1 is read-only. A recommendation is informational only: the application
 * never applies it and never performs filesystem modification.
 */
export type RecommendationKind =
  | "temporary-files"
  | "cache"
  | "large-file"
  | "download"
  | "log"
  | "development-artifact"
  | "duplicate-candidate"
  | "recycle-bin";

export interface Recommendation {
  id: string;
  title: string;
  reason: string;
  category: CategoryId;
  kind: RecommendationKind;
  verdict: Verdict;
  paths: string[];
  /** Estimated logical bytes occupied by the review target. */
  estimatedBytes: number;
}

const KIND_TITLE: Record<RecommendationKind, string> = {
  "temporary-files": "Review temporary files",
  cache: "Review application cache",
  "large-file": "Review unusually large file",
  download: "Review downloaded file",
  log: "Review old log file",
  "development-artifact": "Review build output or dependency folder",
  "duplicate-candidate": "Compare possible duplicate files",
  "recycle-bin": "Check Recycle Bin usage",
};

function kindFor(category: CategoryId, item: Item, verdict: Verdict): RecommendationKind {
  const name = basename(item.path).toLowerCase();
  if (category === "trash") return "recycle-bin";
  if (category === "caches" || name === "cache" || name === "caches") return "cache";
  if (/(^|\/|\\)(temp|tmp)($|\/|\\)|\.tmp$|\.log$/.test(item.path.toLowerCase())) return name.endsWith(".log") ? "log" : "temporary-files";
  if (/node_modules|dist|build|target|\.next|\.cache|\.gradle|\.m2|\.cargo/i.test(name)) return "development-artifact";
  if (verdict === "junk" && !item.dir) return "download";
  if (!item.dir && item.size >= 1e9) return "large-file";
  return "cache";
}

export function recommendationForItem(item: Item, category: CategoryId, label: Label | undefined): Recommendation {
  const verdict = label?.verdict ?? "yours";
  const kind = kindFor(category, item, verdict);
  const reason = label?.reason || "Large or rebuildable storage use identified by the read-only scan.";
  return {
    id: `${category}:${item.path}`,
    title: KIND_TITLE[kind],
    reason: `${CATEGORY_REASON[category]} ${reason}`.trim(),
    category,
    kind,
    verdict,
    paths: [item.path],
    estimatedBytes: item.size,
  };
}

const CATEGORY_REASON: Record<CategoryId, string> = {
  apps: "Application data was identified.",
  developer: "Developer storage was identified.",
  photos: "Personal photo storage was identified.",
  movies: "Personal video storage was identified.",
  documents: "Document or download storage was identified.",
  music: "Personal audio storage was identified.",
  system: "System-managed data was identified.",
  caches: "Rebuildable cache storage was identified.",
  trash: "Recycle Bin or Trash usage was identified.",
};

/** Groups same-size, same-name files as candidates only; contents are not read. */
export function duplicateCandidates(items: Item[]): Recommendation[] {
  const groups = new Map<string, Item[]>();
  for (const item of items) {
    if (item.dir || item.size < 1e6) continue;
    const key = `${basename(item.path).toLowerCase()}:${item.size}`;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  const result: Recommendation[] = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    result.push({
      id: `duplicates:${basename(list[0].path)}:${list[0].size}`,
      title: KIND_TITLE["duplicate-candidate"],
      reason: "Same name and byte size; compare these files yourself. Contents were not read and no file is changed.",
      category: "documents",
      kind: "duplicate-candidate",
      verdict: "unused",
      paths: list.map((item) => item.path),
      estimatedBytes: list[0].size * (list.length - 1),
    });
  }
  return result;
}

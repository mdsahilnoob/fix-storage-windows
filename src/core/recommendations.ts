import { basename } from "node:path";
import type { CategoryId } from "./categories";
import type { Label, Verdict } from "./classify";
import type { Item } from "./scan";

/**
 * v1 is read-only. Recommendations are informational only: the application
 * never applies them and never performs filesystem modification.
 */
export const REVIEW_CATEGORIES = ["apps", "developer", "documents", "caches", "trash"] as const;
export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];

export function isReviewCategory(id: CategoryId): id is ReviewCategory {
  return (REVIEW_CATEGORIES as readonly string[]).includes(id);
}

export type RecommendationKind =
  | "review"
  | "temporary-files"
  | "cache"
  | "large-file"
  | "download"
  | "log"
  | "development-artifact"
  | "recycle-bin";

export interface DuplicateGroup {
  id: string;
  name: string;
  /** Matching byte size for every candidate. */
  size: number;
  count: number;
  paths: string[];
  /** Conditional estimate only; contents have not been compared. */
  estimatedConditionalBytes: number;
  warning: string;
}

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
  /** Possible duplicates, never presented as confirmed identical files. */
  duplicateGroups?: DuplicateGroup[];
}

const KIND_TITLE: Record<RecommendationKind, string> = {
  review: "Review storage item",
  "temporary-files": "Review temporary files",
  cache: "Review application cache",
  "large-file": "Review unusually large file",
  download: "Review downloaded file",
  log: "Review old log file",
  "development-artifact": "Review build output or dependency folder",
  "recycle-bin": "Check Recycle Bin usage",
};

const DOWNLOADS = /(^|\/|\\)downloads?($|\/|\\)/i;
const TEMP_PATH = /(^|\/|\\)(temp|tmp)($|\/|\\)|\.tmp$/i;
const DEV_ARTIFACT = /(^|\/|\\)(node_modules|dist|build|target|out|\.next|\.cache|\.gradle|\.m2|\.cargo)(\/|\\|$)/i;

function normalizedPath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

function kindFor(category: CategoryId, item: Item): RecommendationKind {
  const path = normalizedPath(item.path);
  const name = basename(path);
  if (category === "trash") return "recycle-bin";
  if (category === "caches") return "cache";
  if (TEMP_PATH.test(path)) return "temporary-files";
  if (name.endsWith(".log")) return "log";
  if (category === "developer" || DEV_ARTIFACT.test(path)) return "development-artifact";
  // Download classification requires a Downloads location; a junk verdict
  // alone is not enough to call an arbitrary file a download.
  if (category === "documents" && DOWNLOADS.test(path)) return "download";
  if (!item.dir && item.size >= 1e9) return "large-file";
  return "review";
}

export function recommendationForItem(item: Item, category: CategoryId, label: Label | undefined): Recommendation {
  const verdict = label?.verdict ?? "yours";
  const kind = kindFor(category, item);
  const reason = label?.reason || "Storage use identified by the read-only scan.";
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

const CATEGORY_TITLE: Record<ReviewCategory, string> = {
  apps: "Review application storage",
  developer: "Review developer storage",
  documents: "Review document storage",
  caches: "Review cache storage",
  trash: "Check Recycle Bin usage",
};

const CATEGORY_KIND: Record<ReviewCategory, RecommendationKind> = {
  apps: "review",
  developer: "development-artifact",
  documents: "review",
  caches: "cache",
  trash: "recycle-bin",
};

/** Build an informational recommendation for one supported category only. */
export function categoryRecommendation(category: ReviewCategory, items: Item[]): Recommendation {
  const duplicateGroups = duplicateCandidates(items);
  const bytes = items.reduce((total, item) => total + item.size, 0);
  return {
    id: `category:${category}`,
    title: CATEGORY_TITLE[category],
    reason: `${items.length} measured items; ${duplicateGroups.length} possible duplicate groups with matching names and sizes. Contents were not compared. Estimated opportunity only; no file is modified.`,
    category,
    kind: CATEGORY_KIND[category],
    verdict: "unused",
    paths: items.slice(0, 10).map((item) => item.path),
    estimatedBytes: bytes,
    duplicateGroups,
  };
}

const CATEGORY_REASON: Record<CategoryId, string> = {
  apps: "Application data was identified.",
  developer: "Developer storage was identified.",
  photos: "Personal photo storage was identified.",
  movies: "Personal video storage was identified.",
  documents: "Document storage was identified.",
  music: "Personal audio storage was identified.",
  system: "System-managed data was identified.",
  caches: "Rebuildable cache storage was identified.",
  trash: "Recycle Bin or Trash usage was identified.",
};

/**
 * Groups same-name, same-size files as candidates only. Contents are never
 * read, hashed or compared, and the result is not a confirmed duplicate.
 */
export function duplicateCandidates(items: Item[]): DuplicateGroup[] {
  const groups = new Map<string, Item[]>();
  for (const item of items) {
    if (item.dir || item.size < 1e6) continue;
    const key = `${basename(item.path).toLowerCase()}:${item.size}`;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  const result: DuplicateGroup[] = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    result.push({
      id: `duplicates:${basename(list[0].path)}:${list[0].size}`,
      name: basename(list[0].path),
      size: list[0].size,
      count: list.length,
      paths: list.map((item) => item.path),
      estimatedConditionalBytes: list[0].size * (list.length - 1),
      warning: "Contents have not been compared. Same name and byte size only; these are possible, not confirmed, duplicates.",
    });
  }
  return result;
}

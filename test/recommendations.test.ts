import { expect, test } from "bun:test";
import type { CategoryId } from "../src/core/categories";
import type { Label } from "../src/core/classify";
import {
  categoryRecommendation,
  duplicateCandidates,
  isReviewCategory,
  recommendationForItem,
  REVIEW_CATEGORIES,
  type ReviewCategory,
} from "../src/core/recommendations";
import { emptySnapshot, type Item } from "../src/core/scan";
import { Store } from "../src/ui/store";

const junk: Label = { verdict: "junk", reason: "Looks unused." };
const item = (path: string, size: number, dir = false): Item => ({ path, size, dir });

const itemsByCategory: Record<ReviewCategory, Item[]> = {
  apps: [item("C:\\Apps\\Example\\settings.bin", 60e6)],
  developer: [item("C:\\dev\\project\\node_modules\\pkg", 300e6, true)],
  documents: [item("C:\\Users\\me\\Documents\\tax.pdf", 500e6)],
  caches: [item("C:\\Users\\me\\AppData\\Local\\Temp\\blob", 200e6)],
  trash: [item("C:\\$Recycle.Bin\\S-1-5-21\\old.zip", 100e6)],
};

const expectedKind: Record<ReviewCategory, string> = {
  apps: "review",
  developer: "development-artifact",
  documents: "review",
  caches: "cache",
  trash: "recycle-bin",
};

const expectedTitle: Record<ReviewCategory, string> = {
  apps: "Review application storage",
  developer: "Review developer storage",
  documents: "Review document storage",
  caches: "Review cache storage",
  trash: "Check Recycle Bin usage",
};

test("every supported category gets its own recommendation instead of falling back to caches", () => {
  for (const category of REVIEW_CATEGORIES) {
    expect(isReviewCategory(category)).toBe(true);
    const recommendation = categoryRecommendation(category, itemsByCategory[category]);
    expect(recommendation.category).toBe(category);
    expect(recommendation.kind).toBe(expectedKind[category]);
    expect(recommendation.title).toBe(expectedTitle[category]);
    expect(recommendation.id).toBe(`category:${category}`);
    expect(recommendation.estimatedBytes).toBe(itemsByCategory[category].reduce((total, entry) => total + entry.size, 0));
    expect(recommendation.reason).toContain("Contents were not compared.");
    if (category !== "caches") {
      expect(recommendation.title).not.toContain("cache storage");
    }
  }
});

test("unsupported categories are rejected rather than silently mapped", () => {
  const unsupported: CategoryId[] = ["photos", "movies", "music", "system"];
  for (const category of unsupported) expect(isReviewCategory(category)).toBe(false);
});

test("store suggestions come only from supported review categories", async () => {
  const store = seededStore();
  expect(store.suggestion()).toBe("documents");
  for (const category of REVIEW_CATEGORIES) {
    await store.reviewCategory(category);
    const recommendation = store.get().recommendation;
    expect(recommendation?.category).toBe(category);
    expect(recommendation?.kind).toBe(expectedKind[category]);
  }
});

test("store refuses an unsupported category without substituting caches", async () => {
  const store = seededStore();
  await store.reviewCategory("photos");
  expect(store.get().recommendation).toBeNull();
  expect(store.get().note).toContain("No other category was substituted.");
});

test("store reports an empty supported category without inventing a recommendation", async () => {
  const store = seededStore();
  const snapshot = store.get().scan;
  snapshot.items = { ...snapshot.items, caches: [] };
  snapshot.sizes = { ...snapshot.sizes, caches: 0 };
  (store as unknown as { set(patch: Partial<ReturnType<Store["get"]>>): void }).set({ scan: snapshot });

  await store.reviewCategory("caches");
  expect(store.get().recommendation).toBeNull();
  expect(store.get().note).toContain("no measured items to review");
});

test("downloads are classified only when the category and path support it", () => {
  const downloaded = recommendationForItem(item("C:\\Users\\me\\Downloads\\setup.exe", 20e6), "documents", junk);
  expect(downloaded.kind).toBe("download");

  const appFile = recommendationForItem(item("C:\\Apps\\Example\\Downloads\\setup.exe", 20e6), "apps", junk);
  expect(appFile.kind).toBe("review");

  const document = recommendationForItem(item("C:\\Users\\me\\Documents\\letter.docx", 20e6), "documents", junk);
  expect(document.kind).toBe("review");

  const log = recommendationForItem(item("C:\\Apps\\Example\\old.log", 20e6), "apps", junk);
  expect(log.kind).toBe("log");
});

test("download detection is case-insensitive and requires a Downloads path segment", () => {
  const variants = [
    "C:\\Users\\me\\downloads\\ARCHIVE.ZIP",
    "C:\\Users\\me\\Download\\archive.zip",
    "C:\\Users\\me\\OneDrive\\Downloads\\archive.zip",
  ];
  for (const path of variants) {
    expect(recommendationForItem(item(path, 20e6), "documents", junk).kind).toBe("download");
  }

  expect(recommendationForItem(item("C:\\Users\\me\\Downloads-old\\archive.zip", 20e6), "documents", junk).kind).toBe("review");
  expect(recommendationForItem(item("C:\\Users\\me\\MyDownloads\\archive.zip", 20e6), "documents", junk).kind).toBe("review");
});

test("unclassified files stay neutral and preserve the verdict", () => {
  const recommendation = recommendationForItem(
    item("C:\\Users\\me\\Documents\\notes.txt", 2e6),
    "documents",
    { verdict: "junk", reason: "Reviewed manually." },
  );

  expect(recommendation.kind).toBe("review");
  expect(recommendation.title).toBe("Review storage item");
  expect(recommendation.verdict).toBe("junk");
  expect(recommendation.reason).toContain("Document storage was identified.");
  expect(recommendation.reason).toContain("Reviewed manually.");
});

test("large files are identified from metadata without reading contents", () => {
  const file = recommendationForItem(item("C:\\Users\\me\\Documents\\archive.bin", 2_000_000_000), "documents", undefined);
  expect(file.kind).toBe("large-file");
  expect(file.estimatedBytes).toBe(2_000_000_000);
  expect(file.reason).toContain("Document storage was identified.");

  const folder = recommendationForItem(item("C:\\Users\\me\\Documents\\archive", 2_000_000_000, true), "documents", undefined);
  expect(folder.kind).toBe("review");
});

test("duplicate candidates expose groups, paths, matching size and a no-comparison warning", () => {
  const groups = duplicateCandidates([
    item("C:\\Users\\me\\Downloads\\movie.mp4", 1_500_000_000),
    item("C:\\Backup\\movie.mp4", 1_500_000_000),
    item("C:\\Users\\me\\Downloads\\movie.mp4", 1_500_000_000, true),
    item("C:\\Users\\me\\Downloads\\other.mp4", 1_500_000_000),
    item("C:\\Users\\me\\Downloads\\small.mp4", 10),
  ]);

  expect(groups).toHaveLength(1);
  const [group] = groups;
  expect(group.name).toBe("movie.mp4");
  expect(group.size).toBe(1_500_000_000);
  expect(group.count).toBe(2);
  expect(group.paths).toEqual(["C:\\Users\\me\\Downloads\\movie.mp4", "C:\\Backup\\movie.mp4"]);
  expect(group.estimatedConditionalBytes).toBe(1_500_000_000);
  expect(group.warning).toContain("Contents have not been compared.");
  expect(group.warning).toContain("not confirmed");
});

test("same-name files with different sizes are not grouped as candidates", () => {
  const groups = duplicateCandidates([
    item("C:\\Users\\me\\Downloads\\same-name.bin", 2_000_000),
    item("C:\\Backup\\same-name.bin", 3_000_000),
    item("C:\\Users\\me\\Downloads\\different-name.bin", 2_000_000),
  ]);

  expect(groups).toEqual([]);
});

test("conditional savings count every copy except one", () => {
  const size = 1_200_000_000;
  const [group] = duplicateCandidates([
    item("C:\\Users\\me\\Downloads\\three.mp4", size),
    item("C:\\Backup\\three.mp4", size),
    item("C:\\Archive\\three.mp4", size),
  ]);

  expect(group.count).toBe(3);
  expect(group.size).toBe(size);
  expect(group.estimatedConditionalBytes).toBe(size * 2);
  expect(group.paths).toHaveLength(3);
  expect(group.warning).toContain("Contents have not been compared.");
});

test("category recommendations include duplicate candidates, never confirmed duplicates", () => {
  const recommendation = categoryRecommendation("documents", [
    item("C:\\Users\\me\\Downloads\\movie.mp4", 1_500_000_000),
    item("C:\\Backup\\movie.mp4", 1_500_000_000),
  ]);
  expect(recommendation.duplicateGroups).toHaveLength(1);
  expect(recommendation.duplicateGroups?.[0].paths).toHaveLength(2);
  expect(recommendation.reason).toContain("possible duplicate groups");
});

test("overlapping category estimates stay per-category and are never presented as a unique total", () => {
  const shared = item("C:\\Users\\me\\Documents\\shared.bin", 400e6);
  const apps = categoryRecommendation("apps", [shared]);
  const documents = categoryRecommendation("documents", [shared]);

  expect(apps.estimatedBytes).toBe(400e6);
  expect(documents.estimatedBytes).toBe(400e6);
  expect(apps.reason).toContain("Estimated opportunity only");
  expect(documents.reason).toContain("Estimated opportunity only");
  expect(apps.reason).not.toContain("reclaimable");
  expect(documents.reason).not.toContain("reclaimable");
});

function seededStore(): Store {
  const store = new Store({ demo: true });
  const snapshot = emptySnapshot();
  snapshot.phase = "done";
  snapshot.items = { ...snapshot.items, ...itemsByCategory };
  snapshot.sizes = {
    ...snapshot.sizes,
    ...Object.fromEntries(REVIEW_CATEGORIES.map((category) => [category, itemsByCategory[category].reduce((total, entry) => total + entry.size, 0)])),
    photos: 5_000_000_000,
  };
  (store as unknown as { set(patch: Partial<ReturnType<Store["get"]>>): void }).set({ scan: snapshot, selected: "apps" });
  return store;
}

import { join } from "node:path";
import type { Layout } from "../layout";

/**
 * v1 is read-only. The archived native cleanup bridge is not reachable from
 * this module. Only a descriptive location is provided for reports.
 */
export function recycleBinLocation(layout: Layout): string {
  return join(layout.drive.mount, "$Recycle.Bin");
}

export function recycleBinRecommendation(): { title: string; reason: string } {
  return {
    title: "Check Recycle Bin usage",
    reason: "Items already deleted may still occupy space. Review or empty it yourself in Windows; this application never modifies it.",
  };
}

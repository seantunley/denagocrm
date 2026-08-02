import { requireRoute } from "@/lib/permissions";

/**
 * Segment-level gate. It reads the SAME ROUTE_RULES entry the edge proxy applies
 * to /fleets rather than restating the permission list — a restated list is how
 * the two drift apart. (This layout already required fleets.view/fleets.manage
 * while the pages beneath it still called requireCrm(), the per-user module-CSV
 * guard, so the segment and its own pages disagreed about who could be here.)
 *
 * Defence in depth ONLY — every page under this segment repeats the check,
 * because Next caches layouts on the client and does not re-render them between
 * pages of the same segment.
 */
export default async function FleetsLayout({ children }: { children: React.ReactNode }) {
  await requireRoute("/fleets");
  return children;
}

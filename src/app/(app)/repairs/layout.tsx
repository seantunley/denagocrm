import { requireRoute } from "@/lib/permissions";

/**
 * Segment-level gate, mirroring `{ prefix: "/repairs", tenantOwner: true }` in
 * routeAccess.ts so the authorization holds when the proxy is not in the path.
 *
 * Through `requireRoute` rather than a restated predicate: the rule lives in one
 * table, and this reads it. Spelled out by hand as `requireOwner()` it was also
 * saying PLATFORM owner — which would have kept every other workspace's owner out
 * of their own repairs inbox even once the route rule let them in.
 *
 * Defence in depth ONLY — layouts are client-cached and do not re-render between
 * pages of the same segment, so the page keeps its own guard, and so does every
 * server action.
 */
export default async function RepairsLayout({ children }: { children: React.ReactNode }) {
  await requireRoute("/repairs");
  return children;
}

import { requireOwner } from "@/lib/auth";

/**
 * Segment-level owner gate, mirroring `{ prefix: "/repairs", owner: true }` in
 * routeAccess.ts so the authorization holds when the proxy is not in the path.
 *
 * Defence in depth ONLY — layouts are client-cached and do not re-render between
 * pages of the same segment, so the page keeps its own requireOwner(), and so
 * does every server action.
 */
export default async function RepairsLayout({ children }: { children: React.ReactNode }) {
  await requireOwner();
  return children;
}

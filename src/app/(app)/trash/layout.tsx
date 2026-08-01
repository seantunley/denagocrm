import { requireOwner } from "@/lib/auth";

/**
 * Segment-level owner gate for the recycle bin, mirroring the
 * `{ prefix: "/trash", gate: "admin" }` rule in ROUTE_GATES so the
 * authorization holds when the proxy is not in the path.
 *
 * Defence in depth ONLY — see the note in ../products/layout.tsx: layouts are
 * client-cached and do not re-render between pages of the same segment, so the
 * page keeps its own requireOwner().
 */
export default async function TrashLayout({ children }: { children: React.ReactNode }) {
  await requireOwner();
  return children;
}

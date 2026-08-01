import { requireOwner } from "@/lib/auth";

/**
 * Segment-level owner gate for the catalogue management screens, mirroring the
 * `{ prefix: "/products", gate: "admin" }` rule in ROUTE_GATES so the
 * authorization holds when the proxy is not in the path.
 *
 * Defence in depth ONLY — every page under this segment repeats the check.
 * Next.js caches layouts on the client and does not re-render them while
 * navigating between pages of the same segment
 * (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/layout.md,
 * "Caveats → Request Object"), so a layout is not a boundary you can rely on
 * alone. It is here so a page added later is denied by default.
 */
export default async function ProductsLayout({ children }: { children: React.ReactNode }) {
  await requireOwner();
  return children;
}

import { requireRoute } from "@/lib/permissions";

/**
 * Segment-level gate reading the SAME ROUTE_RULES entry the edge proxy applies
 * to /surveys — see ../fleets/layout.tsx for why the rule is looked up rather
 * than restated. Defence in depth only; each page repeats the check.
 */
export default async function SurveysLayout({ children }: { children: React.ReactNode }) {
  await requireRoute("/surveys");
  return children;
}

import CRMHome from "@/components/home/CRMHome";
import { requireUser } from "@/lib/auth";
import { DEFAULT_DASHBOARD_SLUG, dashboardBySlug } from "@/lib/dashboard/store";

/**
 * The product home screen is intentionally not rendered by the dashboard builder.
 *
 * The builder remains available for user-authored dashboards under /d/:slug, but
 * the CRM landing page has a fixed information hierarchy designed around the work
 * people need to do when they open the product. Letting an arbitrary card grid
 * own `/` is what made the previous home screen feel like a collection of widgets
 * instead of a product surface.
 */
export default async function HomePage() {
  /*
   * EXPLICIT, even though it looks redundant.
   *
   * This page was authenticated only as a SIDE EFFECT: `dashboardBySlug` calls
   * `dashboardViewer`, which calls `requireUser`. That works, and it worked
   * before this change — but it makes the guard on the product's landing page an
   * incidental property of a data call made for another reason entirely.
   * Replacing that line with a prop, a cache, or a different lookup would
   * silently unguard `/`, and nothing here would look wrong.
   *
   * Free to state: the resolution underneath it (`resolveCurrentUser`) is
   * wrapped in React `cache()`, so this shares the one lookup the render was
   * going to do anyway rather than adding a second round trip.
   */
  await requireUser();
  const customHome = await dashboardBySlug(DEFAULT_DASHBOARD_SLUG);
  return <CRMHome hasCustomDashboard={Boolean(customHome)} />;
}

import CRMHome from "@/components/home/CRMHome";
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
  const customHome = await dashboardBySlug(DEFAULT_DASHBOARD_SLUG);
  return <CRMHome hasCustomDashboard={Boolean(customHome)} />;
}

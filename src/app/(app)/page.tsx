import CRMHome from "@/components/home/CRMHome";
import HomeCustomise from "@/components/home/HomeCustomise";
import { requireUser } from "@/lib/auth";

/**
 * The product home screen is intentionally not rendered by the dashboard builder.
 *
 * User-authored dashboards remain available under /d/:slug, but the reserved
 * `home` slug now redirects here. That keeps one authoritative CRM landing page
 * instead of letting a legacy saved dashboard resurface as a second "Home".
 */
export default async function HomePage() {
  // Keep the auth boundary explicit even though CRMHome's data loaders also
  // resolve the current user. The landing page should never depend on that side
  // effect for protection.
  await requireUser();

  return (
    <div data-home-root className="w-full">
      <div className="mb-3 flex justify-end">
        <HomeCustomise />
      </div>
      <CRMHome hasCustomDashboard={false} />
    </div>
  );
}

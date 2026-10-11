import { notFound } from "next/navigation";
import DashboardScreen from "@/components/dashboard/DashboardScreen";
import { DEFAULT_DASHBOARD_SLUG, dashboardBySlug, defaultDashboard } from "@/lib/dashboard/store";

/**
 * A named dashboard.
 *
 * `dashboardBySlug` resolves against the SESSION user only, so a slug belonging
 * to somebody else is indistinguishable here from one that does not exist —
 * both are `null`, both are a 404. That is deliberate: a "you are not allowed to
 * see this dashboard" response would confirm that a colleague has one called
 * `commissions`, which is a small disclosure but a free one to avoid.
 *
 * The one slug that always exists is the first dashboard, `home`: somebody who
 * has never customised it has no stored row, and gets the generated default —
 * exactly what "/" showed them before the home screen became the "do next"
 * page. Nothing anybody built is lost; it has an address of its own now.
 */
export default async function NamedDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { slug } = await params;
  const { tab } = await searchParams;
  const dashboard = (await dashboardBySlug(slug)) ?? (slug === DEFAULT_DASHBOARD_SLUG ? defaultDashboard() : null);
  if (!dashboard) notFound();
  return <DashboardScreen dashboard={dashboard} tab={tab} />;
}

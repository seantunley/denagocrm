import { notFound } from "next/navigation";
import DashboardScreen from "@/components/dashboard/DashboardScreen";
import { dashboardBySlug } from "@/lib/dashboard/store";

/**
 * A named dashboard.
 *
 * `dashboardBySlug` resolves against the SESSION user only, so a slug belonging
 * to somebody else is indistinguishable here from one that does not exist —
 * both are `null`, both are a 404. That is deliberate: a "you are not allowed to
 * see this dashboard" response would confirm that a colleague has one called
 * `commissions`, which is a small disclosure but a free one to avoid.
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
  const dashboard = await dashboardBySlug(slug);
  if (!dashboard) notFound();
  return <DashboardScreen dashboard={dashboard} tab={tab} />;
}

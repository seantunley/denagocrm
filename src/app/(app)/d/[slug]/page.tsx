import { notFound, redirect } from "next/navigation";
import DashboardScreen from "@/components/dashboard/DashboardScreen";
import { dashboardBySlug } from "@/lib/dashboard/store";

/**
 * A named custom dashboard.
 *
 * `home` is reserved for the product home screen at `/`. Keeping an old saved
 * dashboard addressable at `/d/home` made it look as though the redesign had
 * reverted whenever that legacy route was opened. Other named dashboards remain
 * fully available through this route.
 *
 * `dashboardBySlug` resolves against the SESSION user only, so a slug belonging
 * to somebody else is indistinguishable here from one that does not exist —
 * both are `null`, both are a 404.
 */
export default async function NamedDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { slug } = await params;
  if (slug === "home") redirect("/");

  const { tab } = await searchParams;
  const dashboard = await dashboardBySlug(slug);
  if (!dashboard) notFound();
  return <DashboardScreen dashboard={dashboard} tab={tab} />;
}

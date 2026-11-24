import DashboardScreen from "@/components/dashboard/DashboardScreen";
import { requireAnyPermission } from "@/lib/permissions";
import { dashboardBySlug, templateDashboard } from "@/lib/dashboard/store";
import { templateBySlug } from "@/lib/dashboard/templates";

const SLUG = "command-centre";

/**
 * The Command Centre — the management template at its own address, because the
 * sidebar links here on a permission and that permission must be enforced by the
 * page it opens (tests/oneAuthorizationSource.test.ts). Otherwise identical to
 * /d/[slug]: the viewer's own copy once they have customised it, else the
 * generated template (lib/dashboard/templates.ts).
 */
export default async function CommandCentrePage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  // Their own (or a workspace-shared) dashboard at this address: reachable like any other of theirs.
  const stored = await dashboardBySlug(SLUG);
  if (stored) return <DashboardScreen dashboard={stored} tab={tab} />;
  // The template is offered on the same permissions as the sidebar link.
  await requireAnyPermission(...templateBySlug(SLUG)!.permissions);
  return <DashboardScreen dashboard={templateDashboard(SLUG)!} tab={tab} />;
}

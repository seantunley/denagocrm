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
  // The address is guarded on the sidebar link's permissions BEFORE anything is
  // read — a stored, shared or just-customised copy at this slug does not get round
  // it (review of #1229).
  await requireAnyPermission(...templateBySlug(SLUG)!.permissions);
  const { tab } = await searchParams;
  // Their own (or a workspace-shared) customised copy, else the generated template.
  const stored = await dashboardBySlug(SLUG);
  return <DashboardScreen dashboard={stored ?? templateDashboard(SLUG)!} tab={tab} />;
}

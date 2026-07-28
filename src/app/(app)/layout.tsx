import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { awaitingReplyCount } from "@/lib/inboxCount";
import { casesAwaitingCount } from "@/lib/helpdesk";
import { getUserPermissionList } from "@/lib/permissions";
import { getEnabledModuleIds } from "@/lib/modules/enabled";
import { assertPathModuleEnabled } from "@/lib/modules/routeGuard";
import { tenantEnforcing } from "@/lib/tenantEnforcement";
import { currentTenantScope } from "@/lib/tenantScope";
import AppShell from "@/components/AppShell";

export default async function AppLayout({
  children,
  modal,
}: Readonly<{ children: React.ReactNode; modal?: React.ReactNode }>) {
  const user = await requireUser();

  // Owner lockout escape hatch (DORMANT off): under enforcement, an owner whose
  // request resolved NO active tenant scope (establishStaffTenantScope granted the
  // owner no scope, on purpose) must land on the platform console to fix their
  // tenancy — not this fail-closed CRM shell, whose tenant-scoped reads below would
  // all throw. Non-owners can't reach here in that state: they'd have failed auth
  // (ok:false) and requireUser would already have redirected to /login. The whole
  // branch is inert while enforcement is off, so behaviour is unchanged.
  if (tenantEnforcing() && user.role === "owner" && !currentTenantScope()?.tenantId) {
    redirect("/platform/tenants");
  }

  const [inboxWaiting, casesWaiting, permissions, enabledModules] = await Promise.all([
    awaitingReplyCount(user).catch(() => 0),
    casesAwaitingCount(user).catch(() => 0),
    getUserPermissionList(user),
    getEnabledModuleIds().catch(() => null),
  ]);

  // Single-point route block: a page belonging to a disabled module is not
  // reachable by direct URL, not just hidden from the nav. Shared with the
  // /messages PWA and (print) layouts via the routeGuard helper.
  await assertPathModuleEnabled();

  return (
    <AppShell
      user={{
        name: user.name,
        role: user.role,
        modules: user.modules,
        permissions,
        avatarVersion: user.avatarRef ? user.avatarUpdatedAt?.toISOString() ?? "current" : null,
      }}
      inboxWaiting={inboxWaiting}
      casesWaiting={casesWaiting}
      enabledModules={enabledModules ? [...enabledModules] : undefined}
    >
      {children}
      {modal}
    </AppShell>
  );
}

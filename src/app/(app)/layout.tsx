import { requireUser } from "@/lib/auth";
import { awaitingReplyCount } from "@/lib/inboxCount";
import { casesAwaitingCount } from "@/lib/helpdesk";
import { getUserPermissionList } from "@/lib/permissions";
import { getEnabledModuleIds } from "@/lib/modules/enabled";
import { assertPathModuleEnabled } from "@/lib/modules/routeGuard";
import AppShell from "@/components/AppShell";

export default async function AppLayout({
  children,
  modal,
}: Readonly<{ children: React.ReactNode; modal?: React.ReactNode }>) {
  const user = await requireUser();
  const [inboxWaiting, casesWaiting, permissions, enabledModules] = await Promise.all([
    awaitingReplyCount().catch(() => 0),
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

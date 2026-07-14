import { requireUser } from "@/lib/auth";
import { awaitingReplyCount } from "@/lib/inboxCount";
import { getUserPermissionList } from "@/lib/permissions";
import AppShell from "@/components/AppShell";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await requireUser();
  const [inboxWaiting, permissions] = await Promise.all([
    awaitingReplyCount().catch(() => 0),
    getUserPermissionList(user),
  ]);

  return (
    <AppShell
      user={{
        name: user.name,
        role: user.role,
        modules: user.modules,
        permissions,
      }}
      inboxWaiting={inboxWaiting}
    >
      {children}
    </AppShell>
  );
}

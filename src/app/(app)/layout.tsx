import { requireUser } from "@/lib/auth";
import { awaitingReplyCount } from "@/lib/inboxCount";
import AppShell from "@/components/AppShell";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await requireUser();
  const inboxWaiting = await awaitingReplyCount().catch(() => 0);

  return (
    <AppShell
      user={{ name: user.name, role: user.role, modules: user.modules }}
      inboxWaiting={inboxWaiting}
    >
      {children}
    </AppShell>
  );
}

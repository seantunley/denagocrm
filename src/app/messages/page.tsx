import { prisma } from "@/lib/db";
import { accessibleInboxWhere, requireAnyPermission } from "@/lib/permissions";
import AutoRefresh from "@/components/AutoRefresh";
import Tabs from "@/components/Tabs";
import SocialThreadList from "@/components/SocialThreadList";
import PushToggle from "@/components/PushToggle";
import { buildInboxThreads } from "@/lib/inboxThreads";

export const metadata = { title: "Chats — Denago Messages" };

export default async function MessagesChatsPage() {
  const user = await requireAnyPermission("inbox.view", "inbox.reply");

  // Scope to the contacts/leads this user may see; {} for view_all users.
  const scopeWhere = await accessibleInboxWhere(user);

  const comms = await prisma.communication.findMany({
    where: { type: { in: ["whatsapp", "messenger", "instagram"] }, ...scopeWhere, archivedAt: null },
    orderBy: { occurredAt: "desc" },
    take: 400,
    include: { contact: true, lead: true },
  });

  const threads = buildInboxThreads(comms);
  const unread = threads.filter((t) => t.unread).length;

  return (
    <div className="space-y-4">
      <AutoRefresh seconds={30} />
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Chats</h1>
        <p className="text-xs text-muted-foreground">
          {unread > 0 ? `${unread} unread · ` : ""}WhatsApp, Messenger &amp; Instagram
        </p>
      </div>

      <details className="card">
        <summary className="cursor-pointer list-none text-sm font-medium">
          🔔 Notifications
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            get pinged on new messages — tap to set up
          </span>
        </summary>
        <div className="mt-3">
          <PushToggle />
        </div>
      </details>

      <Tabs
        tabs={[
          {
            key: "all",
            label: "All",
            count: unread,
            content: (
              <SocialThreadList
                list={threads}
                empty="No conversations yet. WhatsApp chats appear once the number is connected; Messenger and Instagram DMs flow once Meta approves messaging."
                revalidate="/messages"
              />
            ),
          },
          {
            key: "whatsapp",
            label: "WhatsApp",
            count: threads.filter((t) => t.channel === "whatsapp" && t.unread).length,
            content: (
              <SocialThreadList
                list={threads.filter((t) => t.channel === "whatsapp")}
                empty="No WhatsApp conversations yet."
                revalidate="/messages"
              />
            ),
          },
          {
            key: "messenger",
            label: "Messenger",
            count: threads.filter((t) => t.channel === "messenger" && t.unread).length,
            content: (
              <SocialThreadList
                list={threads.filter((t) => t.channel === "messenger")}
                empty="No Messenger conversations yet."
                revalidate="/messages"
              />
            ),
          },
          {
            key: "instagram",
            label: "Instagram",
            count: threads.filter((t) => t.channel === "instagram" && t.unread).length,
            content: (
              <SocialThreadList
                list={threads.filter((t) => t.channel === "instagram")}
                empty="No Instagram DMs yet."
                revalidate="/messages"
              />
            ),
          },
        ]}
      />
    </div>
  );
}

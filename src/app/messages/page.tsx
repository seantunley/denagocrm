import { prisma } from "@/lib/db";
import { accessibleInboxWhere, requireAnyPermission } from "@/lib/permissions";
import AutoRefresh from "@/components/AutoRefresh";
import Tabs from "@/components/Tabs";
import SocialThreadList from "@/components/SocialThreadList";
import InstallAppButton from "@/components/InstallAppButton";
import { buildInboxThreads } from "@/lib/inboxThreads";
import { conversationIdsForThreads } from "@/lib/inboxConversations";

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
  // Resolved BEFORE the reply boxes render, not when Send is pressed: a Messenger
  // or Instagram reply is delivered on the channel this row names, so without it
  // the box has nothing to post and refuses. The full inbox gets the same ids via
  // its collaboration payload.
  const conversations = await conversationIdsForThreads(threads);
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

      <InstallAppButton />

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
                conversations={conversations}
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
                conversations={conversations}
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
                conversations={conversations}
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
                conversations={conversations}
                revalidate="/messages"
              />
            ),
          },
        ]}
      />
    </div>
  );
}

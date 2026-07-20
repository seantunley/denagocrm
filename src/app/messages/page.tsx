import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import AutoRefresh from "@/components/AutoRefresh";
import Tabs from "@/components/Tabs";
import SocialThreadList from "@/components/SocialThreadList";
import { buildInboxThreads } from "@/lib/inboxThreads";

export const metadata = { title: "Chats — Denago Messages" };

export default async function MessagesChatsPage() {
  await requireUser();

  const comms = await prisma.communication.findMany({
    where: { type: { in: ["whatsapp", "messenger", "instagram"] }, archivedAt: null },
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

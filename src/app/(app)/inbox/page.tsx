import { MessageSquare } from "lucide-react";
import { prisma, basePrisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import AutoRefresh from "@/components/AutoRefresh";
import Tabs from "@/components/Tabs";
import SocialThreadList from "@/components/SocialThreadList";
import { buildInboxThreads } from "@/lib/inboxThreads";
import { formatDateTime } from "@/lib/format";
import { PageHeader } from "@/components/page-header";

export const metadata = { title: "Social inbox — DenagoCRM" };

export default async function InboxPage() {
  await requireUser();

  // Query active and archived separately so a burst of archived test chats can't
  // consume the take budget and starve older active conversations from the inbox.
  const channelWhere = { type: { in: ["whatsapp", "messenger", "instagram"] } };
  const [activeComms, archivedComms, reviews, placeId] = await Promise.all([
    prisma.communication.findMany({
      where: { ...channelWhere, archivedAt: null },
      orderBy: { occurredAt: "desc" },
      take: 400,
      include: { contact: true, lead: true },
    }),
    prisma.communication.findMany({
      where: { ...channelWhere, archivedAt: { not: null } },
      orderBy: { occurredAt: "desc" },
      take: 400,
      include: { contact: true, lead: true },
    }),
    basePrisma.googleReview.findMany({ orderBy: { publishedAt: "desc" }, take: 10 }),
    prisma.appSetting.findUnique({ where: { key: "GOOGLE_PLACE_ID" } }),
  ]);

  const threadList = buildInboxThreads(activeComms);
  const archivedList = buildInboxThreads(archivedComms);

  return (
    <div className="space-y-5">
      <AutoRefresh seconds={60} />
      <PageHeader title="Social inbox" description={`${threadList.filter((thread) => thread.unread).length} unread · WhatsApp, Messenger, Instagram and Google reviews.`}>
        <a href="/messages" target="_blank" className="btn-secondary btn-sm inline-flex items-center gap-1.5">
          <MessageSquare className="size-4" /> Messages app ↗
        </a>
      </PageHeader>

      <Tabs
        tabs={[
          {
            key: "all",
            label: "All",
            count: threadList.filter((t) => t.unread).length,
            content: <SocialThreadList list={threadList} empty="No conversations yet. WhatsApp chats appear once the number is connected; Messenger and Instagram DMs flow for app admins now and for everyone once Meta approves the messaging permissions." />,
          },
          {
            key: "whatsapp",
            label: "WhatsApp",
            count: threadList.filter((t) => t.channel === "whatsapp" && t.unread).length,
            content: (
              <SocialThreadList
                list={threadList.filter((t) => t.channel === "whatsapp")}
                empty="No WhatsApp conversations yet — they start once the WhatsApp Business number is connected in Settings → Integrations."
              />
            ),
          },
          {
            key: "messenger",
            label: "Messenger",
            count: threadList.filter((t) => t.channel === "messenger" && t.unread).length,
            content: (
              <SocialThreadList
                list={threadList.filter((t) => t.channel === "messenger")}
                empty="No Messenger conversations yet."
              />
            ),
          },
          {
            key: "instagram",
            label: "Instagram",
            count: threadList.filter((t) => t.channel === "instagram" && t.unread).length,
            content: (
              <SocialThreadList
                list={threadList.filter((t) => t.channel === "instagram")}
                empty="No Instagram DMs yet — they flow once the Instagram account is linked to the page and Meta approves messaging."
              />
            ),
          },
          {
            key: "reviews",
            label: "Google Reviews",
            count: reviews.length,
            content: (
              <div className="card max-w-2xl">
                {reviews.length === 0 ? (
                  <p className="text-sm text-slate-400">
                    {placeId?.value
                      ? "No reviews yet — new ones appear here within 6 hours with a push notification."
                      : "Connect your Places API key and Place ID in Settings → Integrations to pull reviews in."}
                  </p>
                ) : (
                  <ul className="divide-y divide-slate-800">
                    {reviews.map((r) => (
                      <li key={r.id} className="py-3">
                        <p className="text-sm">
                          <span className="text-amber-400">{"⭐".repeat(Math.min(5, r.rating))}</span>{" "}
                          <span className="font-medium">{r.author}</span>
                        </p>
                        {r.text && <p className="text-xs text-slate-400 mt-1 line-clamp-4">{r.text}</p>}
                        <p className="text-xs text-slate-500 mt-1">{formatDateTime(r.publishedAt)}</p>
                      </li>
                    ))}
                  </ul>
                )}
                {placeId?.value && (
                  <a
                    href={`https://search.google.com/local/reviews?placeid=${encodeURIComponent(placeId.value)}`}
                    target="_blank"
                    className="btn-secondary btn-sm mt-3 inline-flex"
                  >
                    Reply on Google →
                  </a>
                )}
              </div>
            ),
          },
          {
            key: "archived",
            label: "Archived",
            count: archivedList.length,
            content: (
              <SocialThreadList
                list={archivedList}
                empty="Nothing archived. Open a thread and choose Archive to hide test or finished conversations here without deleting them."
              />
            ),
          },
        ]}
      />
    </div>
  );
}

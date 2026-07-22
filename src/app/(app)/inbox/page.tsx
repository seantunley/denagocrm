import { ExternalLink, Inbox, MessageSquare, Star } from "lucide-react";
import { prisma, basePrisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { accessibleInboxWhere } from "@/lib/permissions";
import AutoRefresh from "@/components/AutoRefresh";
import Tabs from "@/components/Tabs";
import SocialThreadList from "@/components/SocialThreadList";
import { buildInboxThreads } from "@/lib/inboxThreads";
import { formatDateTime } from "@/lib/format";
import { EmptyState, SectionHeading, Surface } from "@/components/visual-system";
import { WorkspaceHero } from "@/components/workspace-hero";

export const metadata = { title: "Social inbox — DenagoCRM" };

export default async function InboxPage() {
  const user = await requireUser();
  const scopeWhere = await accessibleInboxWhere(user);
  const channelWhere = { type: { in: ["whatsapp", "messenger", "instagram"] } };
  const [activeComms, archivedComms, reviews, placeId] = await Promise.all([
    prisma.communication.findMany({
      where: { ...channelWhere, ...scopeWhere, archivedAt: null },
      orderBy: { occurredAt: "desc" },
      take: 400,
      include: { contact: true, lead: true },
    }),
    prisma.communication.findMany({
      where: { ...channelWhere, ...scopeWhere, archivedAt: { not: null } },
      orderBy: { occurredAt: "desc" },
      take: 400,
      include: { contact: true, lead: true },
    }),
    basePrisma.googleReview.findMany({ orderBy: { publishedAt: "desc" }, take: 10 }),
    prisma.appSetting.findUnique({ where: { key: "GOOGLE_PLACE_ID" } }),
  ]);

  const threadList = buildInboxThreads(activeComms);
  const archivedList = buildInboxThreads(archivedComms);
  const unread = threadList.filter((thread) => thread.unread).length;
  const awaiting = threadList.filter((thread) => thread.awaiting).length;
  const channelCount = (channel: string) => threadList.filter((thread) => thread.channel === channel).length;

  const reviewsPanel = (
    <Surface className="max-w-4xl p-5">
      <SectionHeading title="Latest Google reviews" description="Recent public feedback from your connected Google Business profile." />
      {reviews.length === 0 ? (
        <EmptyState
          icon={Star}
          title="No reviews yet"
          description={placeId?.value
            ? "New reviews appear here within six hours and trigger a push notification."
            : "Connect your Places API key and Place ID in Settings → Integrations to pull reviews in."}
          className="mt-4 py-8"
        />
      ) : (
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {reviews.map((review) => (
            <li key={review.id} className="rounded-xl border border-border/70 bg-muted/[0.16] p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="truncate text-sm font-semibold">{review.author}</p>
                <span className="shrink-0 text-xs font-medium text-amber-300">{review.rating}/5 ★</span>
              </div>
              {review.text ? <p className="mt-2 line-clamp-4 text-xs leading-5 text-muted-foreground">{review.text}</p> : <p className="mt-2 text-xs italic text-muted-foreground">Rating only</p>}
              <p className="mt-3 text-[10px] text-muted-foreground/70">{formatDateTime(review.publishedAt)}</p>
            </li>
          ))}
        </ul>
      )}
      {placeId?.value ? (
        <a href={`https://search.google.com/local/reviews?placeid=${encodeURIComponent(placeId.value)}`} target="_blank" className="btn-secondary btn-sm mt-4 inline-flex">
          Reply on Google <ExternalLink className="size-3.5" />
        </a>
      ) : null}
    </Surface>
  );

  return (
    <div className="space-y-6">
      <AutoRefresh seconds={60} />
      <WorkspaceHero
        icon={Inbox}
        eyebrow="Customer conversations"
        title="Social inbox"
        description="Triage social conversations and public feedback from one focused queue."
        stats={[
          { label: "Active threads", value: threadList.length, detail: "Across connected channels" },
          { label: "Unread", value: unread, detail: unread ? "Needs attention" : "You're caught up", tone: unread ? "warning" : "success" },
          { label: "Reply due", value: awaiting, detail: "Customer sent the latest message", tone: awaiting ? "primary" : "default" },
          { label: "Archived", value: archivedList.length, detail: "Finished or hidden threads" },
        ]}
        actions={<a href="/messages" target="_blank" className="btn-primary btn-sm"><MessageSquare className="size-4" /> Open Messages app <ExternalLink className="size-3.5" /></a>}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { label: "WhatsApp", icon: "/branding/social-whatsapp.png", count: channelCount("whatsapp") },
          { label: "Messenger", icon: "/branding/social-facebook.png", count: channelCount("messenger") },
          { label: "Instagram", icon: "/branding/social-instagram.png", count: channelCount("instagram") },
        ].map((channel) => (
          <Surface key={channel.label} className="flex items-center gap-3 px-4 py-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={channel.icon} alt="" className="size-7 rounded-lg" />
            <div className="min-w-0 flex-1"><p className="text-sm font-medium">{channel.label}</p><p className="text-[11px] text-muted-foreground">Active conversations</p></div>
            <span className="text-xl font-semibold tabular-nums text-foreground">{channel.count}</span>
          </Surface>
        ))}
      </div>

      <Tabs
        tabs={[
          { key: "all", label: "All", count: unread, content: <SocialThreadList list={threadList} empty="No conversations yet. Messages appear here as soon as a connected customer channel receives one." /> },
          { key: "whatsapp", label: "WhatsApp", count: threadList.filter((thread) => thread.channel === "whatsapp" && thread.unread).length, content: <SocialThreadList list={threadList.filter((thread) => thread.channel === "whatsapp")} empty="No WhatsApp conversations yet. Connect the WhatsApp Business number in Settings → Integrations." /> },
          { key: "messenger", label: "Messenger", count: threadList.filter((thread) => thread.channel === "messenger" && thread.unread).length, content: <SocialThreadList list={threadList.filter((thread) => thread.channel === "messenger")} empty="No Messenger conversations yet." /> },
          { key: "instagram", label: "Instagram", count: threadList.filter((thread) => thread.channel === "instagram" && thread.unread).length, content: <SocialThreadList list={threadList.filter((thread) => thread.channel === "instagram")} empty="No Instagram DMs yet. They appear once the Instagram account and Meta messaging permissions are connected." /> },
          { key: "reviews", label: "Google Reviews", count: reviews.length, content: reviewsPanel },
          { key: "archived", label: "Archived", count: archivedList.length, content: <SocialThreadList list={archivedList} empty="Nothing archived. Archive finished or test conversations to keep the active queue focused." /> },
        ]}
      />
    </div>
  );
}

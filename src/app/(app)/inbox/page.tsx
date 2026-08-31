import { ExternalLink, Inbox, Star } from "lucide-react";
import { basePrisma } from "@/lib/db";
import { activeTenantPredicate } from "@/lib/tenantPredicate";
import { getActiveTenantId, requireUser } from "@/lib/auth";
import { DEFAULT_TENANT_ID } from "@/lib/tenant";
import { accessibleInboxWhere, hasPermission } from "@/lib/permissions";
import AutoRefresh from "@/components/AutoRefresh";
import Tabs from "@/components/Tabs";
import SocialThreadList from "@/components/SocialThreadList";
import BotHandoffQueue, { type HandoffQueueItem } from "@/components/BotHandoffQueue";
import { buildInboxThreads, threadCollaborationKey } from "@/lib/inboxThreads";
import { loadInboxComms } from "@/lib/inboxQuery";
import { deliveryStateForMessages } from "@/lib/botOutbox";
import { collaborationForThreads } from "@/lib/inboxCollaboration";
import { listActingTenantStaff } from "@/lib/tenantActor";
import { getSetting } from "@/lib/settings";
import { formatDateTime } from "@/lib/format";
import { EmptyState, SectionHeading, Surface } from "@/components/visual-system";
import { WorkspaceHero } from "@/components/workspace-hero";

export const metadata = { title: "Social inbox — DenagoCRM" };

export default async function InboxPage() {
  const user = await requireUser();
  const workspaceTenantId = (await getActiveTenantId()) ?? DEFAULT_TENANT_ID;
  const scopeWhere = await accessibleInboxWhere(user);
  const channelWhere = { type: { in: ["whatsapp", "messenger", "instagram", "x"] } };
  const [activeComms, archivedComms, reviews, placeId] = await Promise.all([
    loadInboxComms({ ...channelWhere, ...scopeWhere }, { archived: false }),
    loadInboxComms({ ...channelWhere, ...scopeWhere }, { archived: true }),
    basePrisma.googleReview.findMany({
      where: { tenantId: workspaceTenantId, ...activeTenantPredicate("inbox Google reviews") },
      orderBy: { publishedAt: "desc" },
      take: 10,
    }),
    getSetting("GOOGLE_PLACE_ID"),
  ]);

  const threadList = buildInboxThreads(activeComms);
  const archivedList = buildInboxThreads(archivedComms);
  const delivery = await deliveryStateForMessages(
    [...threadList, ...archivedList].flatMap((thread) =>
      thread.messages.filter((message) => message.direction === "outbound").map((message) => message.id),
    ),
  );
  const [collaboration, staff, canCollaborate] = await Promise.all([
    collaborationForThreads([...threadList, ...archivedList]),
    listActingTenantStaff(),
    hasPermission(user, "inbox.reply"),
  ]);
  const collabStaff = staff.map((person) => ({ id: person.id, name: person.name }));
  const unread = threadList.filter((thread) => thread.unread).length;
  const awaiting = threadList.filter((thread) => thread.awaiting).length;
  const handoffThreads = threadList.filter((thread) => collaboration.get(thread.key)?.bot.mode === "handoff");
  const humanThreads = threadList.filter((thread) => collaboration.get(thread.key)?.bot.mode === "human");
  const handoffItems: HandoffQueueItem[] = handoffThreads.flatMap((thread) => {
    const key = threadCollaborationKey(thread);
    const collab = key ? collaboration.get(key) : undefined;
    const handoff = collab?.bot.handoff;
    if (!collab || !handoff) return [];
    return [{
      key: thread.key,
      conversationId: collab.conversationId,
      name: thread.name,
      channel: thread.channel,
      reason: handoff.reason,
      summary: handoff.summary,
      intent: handoff.intent,
      confidence: handoff.confidence,
      requestedAt: handoff.requestedAt.toISOString(),
      dueAt: handoff.dueAt.toISOString(),
      overdue: handoff.overdue,
      assigneeId: collab.assignee?.id ?? null,
      assigneeName: collab.assignee?.name ?? null,
    }];
  });
  const overdueHandoffs = handoffItems.filter((item) => item.overdue).length;
  const channelCount = (channel: string) => threadList.filter((thread) => thread.channel === channel).length;

  const handoffsPanel = (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Surface className="p-4"><p className="text-[10px] uppercase tracking-wide text-muted-foreground">Waiting</p><p className="mt-1 text-2xl font-semibold text-amber-300">{handoffItems.length}</p><p className="mt-1 text-[11px] text-muted-foreground">Bot asked for a person</p></Surface>
        <Surface className="p-4"><p className="text-[10px] uppercase tracking-wide text-muted-foreground">SLA overdue</p><p className={`mt-1 text-2xl font-semibold ${overdueHandoffs ? "text-red-300" : "text-emerald-300"}`}>{overdueHandoffs}</p><p className="mt-1 text-[11px] text-muted-foreground">Past the handoff target</p></Surface>
        <Surface className="p-4"><p className="text-[10px] uppercase tracking-wide text-muted-foreground">Human handling</p><p className="mt-1 text-2xl font-semibold text-sky-300">{humanThreads.length}</p><p className="mt-1 text-[11px] text-muted-foreground">Automation currently paused</p></Surface>
      </div>
      <div>
        <div className="mb-3"><h2 className="text-sm font-semibold">Waiting for takeover</h2><p className="mt-1 text-xs text-muted-foreground">Reason, wait time, channel and assignment are visible without opening the conversation.</p></div>
        <BotHandoffQueue items={handoffItems} staff={collabStaff} canAct={canCollaborate} />
      </div>
      {humanThreads.length ? <div><div className="mb-3"><h2 className="text-sm font-semibold">Human handling</h2><p className="mt-1 text-xs text-muted-foreground">These conversations are already claimed or manually paused; open one to return it to the bot when resolved.</p></div><SocialThreadList delivery={delivery} collaboration={collaboration} staff={collabStaff} canCollaborate={canCollaborate} viewerId={user.id} list={humanThreads} empty="No conversations are currently human-controlled." /></div> : null}
    </div>
  );

  const reviewsPanel = (
    <Surface className="max-w-4xl p-5">
      <SectionHeading title="Latest Google reviews" description="Recent public feedback from your connected Google Business profile." />
      {reviews.length === 0 ? (
        <EmptyState icon={Star} title="No reviews yet" description={placeId ? "New reviews appear here within six hours and trigger a push notification." : "Connect your Places API key and Place ID in Settings → Integrations to pull reviews in."} className="mt-4 py-8" />
      ) : (
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {reviews.map((review) => (
            <li key={review.id} className="rounded-xl border border-border/70 bg-muted/[0.16] p-4">
              <div className="flex items-center justify-between gap-3"><p className="truncate text-sm font-semibold">{review.author}</p><span className="shrink-0 text-xs font-medium text-amber-300">{review.rating}/5 ★</span></div>
              {review.text ? <p className="mt-2 line-clamp-4 text-xs leading-5 text-muted-foreground">{review.text}</p> : <p className="mt-2 text-xs italic text-muted-foreground">Rating only</p>}
              <p className="mt-3 text-[10px] text-muted-foreground/70">{formatDateTime(review.publishedAt)}</p>
            </li>
          ))}
        </ul>
      )}
      {placeId ? <a href={`https://search.google.com/local/reviews?placeid=${encodeURIComponent(placeId)}`} target="_blank" className="btn-secondary btn-sm mt-4 inline-flex">Reply on Google <ExternalLink className="size-3.5" /></a> : null}
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
          { label: "Bot handoffs", value: handoffItems.length, detail: overdueHandoffs ? `${overdueHandoffs} overdue` : "Within SLA", tone: overdueHandoffs ? "warning" : handoffItems.length ? "primary" : "success" },
        ]}
        actions={<a href="/messages" target="_blank" rel="noreferrer" className="btn-primary btn-sm">Open Messages app <ExternalLink className="size-4" /></a>}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "WhatsApp", icon: "/branding/social-whatsapp.png", count: channelCount("whatsapp") },
          { label: "Messenger", icon: "/branding/social-facebook.png", count: channelCount("messenger") },
          { label: "Instagram", icon: "/branding/social-instagram.png", count: channelCount("instagram") },
          { label: "X", icon: "/branding/social-x.svg", count: channelCount("x") },
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
        initialKey="all"
        tabs={[
          { key: "handoffs", label: "Bot handoffs", count: handoffThreads.length, content: handoffsPanel },
          { key: "all", label: "All", count: unread, content: <SocialThreadList delivery={delivery} collaboration={collaboration} staff={collabStaff} canCollaborate={canCollaborate} viewerId={user.id} list={threadList} empty="No conversations yet. Messages appear here as soon as a connected customer channel receives one." /> },
          { key: "whatsapp", label: "WhatsApp", count: threadList.filter((thread) => thread.channel === "whatsapp" && thread.unread).length, content: <SocialThreadList delivery={delivery} collaboration={collaboration} staff={collabStaff} canCollaborate={canCollaborate} viewerId={user.id} list={threadList.filter((thread) => thread.channel === "whatsapp")} empty="No WhatsApp conversations yet. Connect the WhatsApp Business number in Settings → Integrations." /> },
          { key: "messenger", label: "Messenger", count: threadList.filter((thread) => thread.channel === "messenger" && thread.unread).length, content: <SocialThreadList delivery={delivery} collaboration={collaboration} staff={collabStaff} canCollaborate={canCollaborate} viewerId={user.id} list={threadList.filter((thread) => thread.channel === "messenger")} empty="No Messenger conversations yet." /> },
          { key: "instagram", label: "Instagram", count: threadList.filter((thread) => thread.channel === "instagram" && thread.unread).length, content: <SocialThreadList delivery={delivery} collaboration={collaboration} staff={collabStaff} canCollaborate={canCollaborate} viewerId={user.id} list={threadList.filter((thread) => thread.channel === "instagram")} empty="No Instagram DMs yet. They appear once the Instagram account and Meta messaging permissions are connected." /> },
          { key: "x", label: "X", count: threadList.filter((thread) => thread.channel === "x" && thread.unread).length, content: <SocialThreadList delivery={delivery} collaboration={collaboration} staff={collabStaff} canCollaborate={canCollaborate} viewerId={user.id} list={threadList.filter((thread) => thread.channel === "x")} empty="No X conversations yet. Connect the tenant's X account in Settings → Integrations." /> },
          { key: "reviews", label: "Google Reviews", count: reviews.length, content: reviewsPanel },
          { key: "archived", label: "Archived", count: archivedList.length, content: <SocialThreadList delivery={delivery} collaboration={collaboration} staff={collabStaff} canCollaborate={canCollaborate} viewerId={user.id} list={archivedList} empty="Nothing archived. Archive finished or test conversations to keep the active queue focused." /> },
        ]}
      />
    </div>
  );
}

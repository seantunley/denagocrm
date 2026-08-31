import { ExternalLink, Hand, Inbox, Star } from "lucide-react";
import { basePrisma } from "@/lib/db";
import { activeTenantPredicate } from "@/lib/tenantPredicate";
import { getActiveTenantId, requireUser } from "@/lib/auth";
import { DEFAULT_TENANT_ID } from "@/lib/tenant";
import { accessibleInboxWhere, hasPermission } from "@/lib/permissions";
import AutoRefresh from "@/components/AutoRefresh";
import Tabs from "@/components/Tabs";
import SocialThreadList from "@/components/SocialThreadList";
import { buildInboxThreads } from "@/lib/inboxThreads";
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
  // The workspace this person is signed in to, resolved identically whether
  // tenant enforcement is off, observing or on.
  const workspaceTenantId = (await getActiveTenantId()) ?? DEFAULT_TENANT_ID;
  const scopeWhere = await accessibleInboxWhere(user);
  const channelWhere = { type: { in: ["whatsapp", "messenger", "instagram", "x"] } };
  const [activeComms, archivedComms, reviews, placeId] = await Promise.all([
    // Threads are chosen by their own recency, then their messages are loaded —
    // so a busy conversation can no longer evict a quiet one from the queue.
    loadInboxComms({ ...channelWhere, ...scopeWhere }, { archived: false }),
    loadInboxComms({ ...channelWhere, ...scopeWhere }, { archived: true }),
    // Reviews are tenant-owned. This read runs on the bypass client, so the
    // predicate the RLS extension would have added has to be added by hand.
    //
    // `activeTenantPredicate` alone is NOT enough, and the reason is the mode
    // this actually ships in. It returns `{}` while enforcement is dormant —
    // correct as a general rule, because filtering on a tenant nobody told us
    // about would hide legacy rows written before the column existed. But an
    // unscoped read is not a migration mechanism: it means that for the whole
    // dormant period — which is every day until enforcement is switched on —
    // this page shows every workspace's reviews to every workspace.
    //
    // The migration beside this change backfills every tenantless review onto
    // the founding tenant, so there are no legacy rows left for a filter to
    // hide. That is what makes filtering safe here, and it is why the two must
    // land together.
    //
    // So the tenant comes from the SESSION — the workspace this person is signed
    // in to — which is resolved the same way in every enforcement mode.
    // activeTenantPredicate is still spread last, so under enforcement the
    // established scope wins and the scopeless-owner case still throws rather
    // than quietly widening to every tenant.
    basePrisma.googleReview.findMany({
      where: { tenantId: workspaceTenantId, ...activeTenantPredicate("inbox Google reviews") },
      orderBy: { publishedAt: "desc" },
      take: 10,
    }),
    getSetting("GOOGLE_PLACE_ID"),
  ]);

  const threadList = buildInboxThreads(activeComms);
  const archivedList = buildInboxThreads(archivedComms);

  // What actually became of each outbound message. Without this the bubbles can
  // only report the customer's side, so anything still queued or permanently
  // rejected renders identically to a message that was delivered.
  const delivery = await deliveryStateForMessages(
    [...threadList, ...archivedList].flatMap((thread) =>
      thread.messages.filter((message) => message.direction === "outbound").map((message) => message.id),
    ),
  );

  // Assignment and notes for the threads already resolved above — so the join
  // inherits their scoping rather than asking about conversations of its own.
  // Staff and the reply permission are loaded once for every thread's panel.
  const [collaboration, staff, canCollaborate] = await Promise.all([
    collaborationForThreads([...threadList, ...archivedList]),
    listActingTenantStaff(),
    hasPermission(user, "inbox.reply"),
  ]);
  const collabStaff = staff.map((person) => ({ id: person.id, name: person.name }));
  const unread = threadList.filter((thread) => thread.unread).length;
  const awaiting = threadList.filter((thread) => thread.awaiting).length;
  const handoffThreads = threadList.filter((thread) => collaboration.get(thread.key)?.bot.mode === "handoff");
  const channelCount = (channel: string) => threadList.filter((thread) => thread.channel === channel).length;

  const reviewsPanel = (
    <Surface className="max-w-4xl p-5">
      <SectionHeading title="Latest Google reviews" description="Recent public feedback from your connected Google Business profile." />
      {reviews.length === 0 ? (
        <EmptyState
          icon={Star}
          title="No reviews yet"
          description={placeId
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
      {placeId ? (
        <a href={`https://search.google.com/local/reviews?placeid=${encodeURIComponent(placeId)}`} target="_blank" className="btn-secondary btn-sm mt-4 inline-flex">
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
        actions={<a href="#handoffs" className="btn-secondary btn-sm"><Hand className="size-4" /> {handoffThreads.length} handoffs</a>}
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
        tabs={[
          { key: "handoffs", label: "Bot handoffs", count: handoffThreads.length, content: <div id="handoffs"><SocialThreadList delivery={delivery} collaboration={collaboration} staff={collabStaff} canCollaborate={canCollaborate} viewerId={user.id} list={handoffThreads} empty="No chatbot handoffs need attention." /></div> },
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

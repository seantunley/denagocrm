import Link from "next/link";
import { prisma, basePrisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import InboxReply from "@/components/InboxReply";
import ConversationCollab, { type CollabNote } from "@/components/ConversationCollab";
import AutoRefresh from "@/components/AutoRefresh";
import Tabs from "@/components/Tabs";
import RowModal from "@/components/RowModal";
import { contactName, formatDateTime } from "@/lib/format";
import { PageHeader } from "@/components/page-header";

export const metadata = { title: "Social inbox — DenagoCRM" };

const DRAFT_LOCK_MS = 5 * 60 * 1000;

const CHANNEL_META: Record<string, { label: string; icon: React.ReactNode }> = {
  whatsapp: {
    label: "WhatsApp",
    // eslint-disable-next-line @next/next/no-img-element
    icon: <img src="/branding/social-whatsapp.png" alt="WhatsApp" className="h-4 w-4 rounded-sm" />,
  },
  messenger: {
    label: "Messenger",
    // eslint-disable-next-line @next/next/no-img-element
    icon: <img src="/branding/social-facebook.png" alt="Messenger" className="h-4 w-4 rounded-sm" />,
  },
  instagram: {
    label: "Instagram",
    // eslint-disable-next-line @next/next/no-img-element
    icon: <img src="/branding/social-instagram.png" alt="Instagram" className="h-4 w-4 rounded-sm" />,
  },
};

type ConvChannel = "whatsapp" | "messenger" | "instagram";

type ConvView = {
  id: string;
  name: string;
  href: string | null;
  channel: ConvChannel;
  contactId: string | null;
  leadId: string | null;
  phone: string | null;
  awaiting: boolean;
  unread: boolean;
  lastAt: Date;
  assignee: { id: string; name: string } | null;
  messages: {
    id: string;
    direction: string | null;
    body: string;
    attachmentUrl: string | null;
    attachmentType: string | null;
  }[];
  notes: CollabNote[];
  myDraft: string;
  draftLockedBy: string | null;
};

export default async function InboxPage() {
  const me = await requireUser();

  const [conversations, staff, reviews, placeId] = await Promise.all([
    prisma.conversation.findMany({
      where: { channel: { in: ["whatsapp", "messenger", "instagram"] }, status: { not: "closed" } },
      orderBy: { lastMessageAt: "desc" },
      take: 200,
      include: {
        contact: true,
        lead: true,
        assignedTo: { select: { id: true, name: true } },
        messages: { orderBy: { occurredAt: "desc" }, take: 10 },
        notes: { orderBy: { createdAt: "desc" }, include: { author: { select: { name: true } } } },
        draft: { include: { owner: { select: { id: true, name: true } } } },
      },
    }),
    prisma.user.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    basePrisma.googleReview.findMany({ orderBy: { publishedAt: "desc" }, take: 10 }),
    prisma.appSetting.findUnique({ where: { key: "GOOGLE_PLACE_ID" } }),
  ]);

  const now = Date.now();
  const list: ConvView[] = conversations.map((c) => {
    const draftMine = c.draft && c.draft.ownerId === me.id;
    const draftRecent = c.draft && now - c.draft.updatedAt.getTime() < DRAFT_LOCK_MS;
    return {
      id: c.id,
      name: c.contact ? contactName(c.contact) : c.lead?.name ?? "Unknown",
      href: c.contactId ? `/contacts/${c.contactId}` : c.leadId ? `/leads/${c.leadId}` : null,
      channel: c.channel as ConvChannel,
      contactId: c.contactId,
      leadId: c.leadId,
      phone: c.contact?.whatsapp ?? c.contact?.phone ?? c.lead?.phone ?? null,
      awaiting: c.lastDirection === "inbound",
      unread: c.unread,
      lastAt: c.lastMessageAt,
      assignee: c.assignedTo ? { id: c.assignedTo.id, name: c.assignedTo.name } : null,
      messages: c.messages.map((m) => ({
        id: m.id,
        direction: m.direction,
        body: m.body,
        attachmentUrl: m.attachmentUrl,
        attachmentType: m.attachmentType,
      })),
      notes: c.notes.map((n) => ({
        id: n.id,
        authorName: n.author.name,
        body: n.body,
        createdAt: formatDateTime(n.createdAt),
      })),
      myDraft: draftMine ? c.draft!.body : "",
      draftLockedBy: c.draft && !draftMine && draftRecent ? c.draft.owner.name : null,
    };
  });

  const sorted = [...list].sort(
    (a, b) => Number(b.awaiting) - Number(a.awaiting) || b.lastAt.getTime() - a.lastAt.getTime()
  );
  const awaitingCount = sorted.filter((t) => t.awaiting).length;
  const byChannel = (ch: ConvChannel) => sorted.filter((t) => t.channel === ch);

  return (
    <div className="space-y-5">
      <AutoRefresh seconds={60} />
      <PageHeader
        title="Social inbox"
        description={`${awaitingCount} awaiting reply · WhatsApp, Messenger, Instagram and Google reviews.`}
      />

      <Tabs
        tabs={[
          {
            key: "all",
            label: "All",
            count: awaitingCount,
            content: (
              <ConversationList
                list={sorted}
                staff={staff}
                meName={me.name}
                empty="No conversations yet. WhatsApp chats appear once the number is connected; Messenger and Instagram DMs flow for app admins now and for everyone once Meta approves the messaging permissions."
              />
            ),
          },
          {
            key: "whatsapp",
            label: "WhatsApp",
            count: byChannel("whatsapp").filter((t) => t.awaiting).length,
            content: (
              <ConversationList
                list={byChannel("whatsapp")}
                staff={staff}
                meName={me.name}
                empty="No WhatsApp conversations yet — they start once the WhatsApp Business number is connected in Settings → Integrations."
              />
            ),
          },
          {
            key: "messenger",
            label: "Messenger",
            count: byChannel("messenger").filter((t) => t.awaiting).length,
            content: (
              <ConversationList
                list={byChannel("messenger")}
                staff={staff}
                meName={me.name}
                empty="No Messenger conversations yet."
              />
            ),
          },
          {
            key: "instagram",
            label: "Instagram",
            count: byChannel("instagram").filter((t) => t.awaiting).length,
            content: (
              <ConversationList
                list={byChannel("instagram")}
                staff={staff}
                meName={me.name}
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
        ]}
      />
    </div>
  );
}

function ConversationList({
  list,
  staff,
  meName,
  empty,
}: {
  list: ConvView[];
  staff: { id: string; name: string }[];
  meName: string;
  empty: string;
}) {
  if (list.length === 0) {
    return <div className="card max-w-2xl text-sm text-slate-400">{empty}</div>;
  }
  return (
    <div className="card p-0 divide-y divide-slate-800 max-w-3xl">
      {list.map((t) => {
        const meta = CHANNEL_META[t.channel];
        const last = t.messages[0];
        const preview = last ? `${last.direction === "outbound" ? "You: " : ""}${last.body}` : "";
        return (
          <RowModal
            key={t.id}
            row={
              <div className="flex items-center gap-3">
                <span className="relative shrink-0">
                  {meta.icon}
                  {t.unread && (
                    <span className="absolute -right-1 -top-1 size-2 rounded-full bg-orange-500 ring-2 ring-[#111412]" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className={`truncate text-sm ${t.unread ? "font-semibold" : "font-medium"}`}>
                    {t.name}
                    <span className="ml-2 text-xs font-normal text-slate-500">{meta.label}</span>
                  </p>
                  <p className="truncate text-xs text-slate-400">{preview}</p>
                </div>
                <div className="shrink-0 text-right">
                  {t.awaiting && (
                    <span className="badge bg-amber-500/15 text-amber-300">awaiting reply</span>
                  )}
                  {t.assignee ? (
                    <p className="mt-0.5 text-[11px] text-slate-400">▸ {t.assignee.name}</p>
                  ) : (
                    <p className="mt-0.5 text-[11px] text-slate-600">unassigned</p>
                  )}
                  <p className="mt-0.5 text-[11px] text-slate-500">{formatDateTime(t.lastAt)}</p>
                </div>
              </div>
            }
          >
            <div className="card">
              <div className="flex flex-wrap items-center gap-2">
                {meta.icon}
                {t.href ? (
                  <Link href={t.href} className="font-semibold text-orange-400 hover:underline">
                    {t.name}
                  </Link>
                ) : (
                  <span className="font-semibold">{t.name}</span>
                )}
                <span className="text-xs text-slate-500">{meta.label}</span>
                <span className="ml-auto text-[11px] text-slate-500">{formatDateTime(t.lastAt)}</span>
              </div>

              <div className="mt-3 space-y-1">
                {[...t.messages].reverse().map((m) => (
                  <div
                    key={m.id}
                    className={`w-fit max-w-[75%] rounded-2xl px-3 py-1.5 text-sm leading-snug whitespace-pre-wrap ${
                      m.direction === "inbound"
                        ? "bg-slate-800 text-slate-200 rounded-bl-md"
                        : "bg-orange-600 text-white ml-auto rounded-br-md"
                    }`}
                  >
                    {m.attachmentUrl && m.attachmentType === "image" ? (
                      <a href={m.attachmentUrl} target="_blank">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={m.attachmentUrl} alt="Attachment" className="max-h-48 rounded-md my-1" />
                      </a>
                    ) : m.attachmentUrl && m.attachmentType === "audio" ? (
                      <audio controls src={m.attachmentUrl} className="my-1 max-w-full" />
                    ) : m.attachmentUrl && m.attachmentType === "video" ? (
                      <video controls src={m.attachmentUrl} className="max-h-48 rounded-md my-1" />
                    ) : m.attachmentUrl ? (
                      <a href={m.attachmentUrl} target="_blank" className="underline text-orange-200">
                        {m.body || "📎 Attachment"}
                      </a>
                    ) : null}
                    {(!m.attachmentUrl ||
                      (m.body &&
                        !m.body.startsWith("🖼") &&
                        !m.body.startsWith("🎤") &&
                        !m.body.startsWith("🎬") &&
                        !m.body.startsWith("📎"))) &&
                      m.body}
                  </div>
                ))}
              </div>

              <ConversationCollab
                conversationId={t.id}
                staff={staff}
                assignedToId={t.assignee?.id ?? null}
                notes={t.notes}
                unread={t.unread}
                meName={meName}
              />

              <InboxReply
                channel={t.channel}
                contactId={t.contactId}
                leadId={t.leadId}
                phone={t.phone}
                revalidate="/inbox"
                conversationId={t.id}
                initialDraft={t.myDraft}
                draftLockedBy={t.draftLockedBy}
              />
            </div>
          </RowModal>
        );
      })}
    </div>
  );
}

import Link from "next/link";
import { prisma, basePrisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import InboxReply from "@/components/InboxReply";
import { markThreadRead } from "@/app/actions/communications";
import AutoRefresh from "@/components/AutoRefresh";
import Tabs from "@/components/Tabs";
import RowModal from "@/components/RowModal";
import { contactName, formatDateTime } from "@/lib/format";
import { PageHeader } from "@/components/page-header";

export const metadata = { title: "Social inbox — DenagoCRM" };

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

export default async function InboxPage() {
  await requireUser();

  const [comms, reviews, placeId] = await Promise.all([
    prisma.communication.findMany({
      where: { type: { in: ["whatsapp", "messenger", "instagram"] } },
      orderBy: { occurredAt: "desc" },
      take: 400,
      include: { contact: true, lead: true },
    }),
    basePrisma.googleReview.findMany({ orderBy: { publishedAt: "desc" }, take: 10 }),
    prisma.appSetting.findUnique({ where: { key: "GOOGLE_PLACE_ID" } }),
  ]);

  type Thread = {
    key: string;
    name: string;
    href: string | null;
    channel: "whatsapp" | "messenger" | "instagram";
    contactId: string | null;
    leadId: string | null;
    phone: string | null;
    awaiting: boolean;
    unread: boolean;
    lastAt: Date;
    messages: {
      id: string;
      direction: string | null;
      body: string;
      at: Date;
      attachmentUrl: string | null;
      attachmentType: string | null;
    }[];
  };

  const threads = new Map<string, Thread>();
  for (const c of comms) {
    const key = c.contactId ? `c:${c.contactId}:${c.type}` : c.leadId ? `l:${c.leadId}:${c.type}` : null;
    if (!key) continue;
    let t = threads.get(key);
    if (!t) {
      t = {
        key,
        name: c.contact ? contactName(c.contact) : c.lead?.name ?? "Unknown",
        href: c.contactId ? `/contacts/${c.contactId}` : c.leadId ? `/leads/${c.leadId}` : null,
        channel: c.type as Thread["channel"],
        contactId: c.contactId,
        leadId: c.leadId,
        phone: c.contact?.whatsapp ?? c.contact?.phone ?? c.lead?.phone ?? null,
        // comms are sorted desc, so the first seen is the newest in the thread.
        // awaiting  = they spoke last and we haven't replied (read or not)
        // unread    = ...and we haven't even opened it yet (readAt null)
        awaiting: c.direction === "inbound",
        unread: c.direction === "inbound" && c.readAt == null,
        lastAt: c.occurredAt,
        messages: [],
      };
      threads.set(key, t);
    }
    if (t.messages.length < 8) {
      t.messages.push({
        id: c.id,
        direction: c.direction,
        body: c.body,
        at: c.occurredAt,
        attachmentUrl: c.attachmentUrl,
        attachmentType: c.attachmentType,
      });
    }
  }
  const threadList = [...threads.values()].sort(
    (a, b) =>
      Number(b.unread) - Number(a.unread) ||
      Number(b.awaiting) - Number(a.awaiting) ||
      b.lastAt.getTime() - a.lastAt.getTime()
  );

  return (
    <div className="space-y-5">
      <AutoRefresh seconds={60} />
      <PageHeader title="Social inbox" description={`${threadList.filter((thread) => thread.unread).length} unread · WhatsApp, Messenger, Instagram and Google reviews.`} />

      <Tabs
        tabs={[
          {
            key: "all",
            label: "All",
            count: threadList.filter((t) => t.unread).length,
            content: <ThreadList list={threadList} empty="No conversations yet. WhatsApp chats appear once the number is connected; Messenger and Instagram DMs flow for app admins now and for everyone once Meta approves the messaging permissions." />,
          },
          {
            key: "whatsapp",
            label: "WhatsApp",
            count: threadList.filter((t) => t.channel === "whatsapp" && t.unread).length,
            content: (
              <ThreadList
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
              <ThreadList
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
              <ThreadList
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
        ]}
      />
    </div>
  );
}

type ThreadForList = {
  key: string;
  name: string;
  href: string | null;
  channel: "whatsapp" | "messenger" | "instagram";
  contactId: string | null;
  leadId: string | null;
  phone: string | null;
  awaiting: boolean;
  unread: boolean;
  lastAt: Date;
  messages: {
    id: string;
    direction: string | null;
    body: string;
    at: Date;
    attachmentUrl: string | null;
    attachmentType: string | null;
  }[];
};

function ThreadList({ list, empty }: { list: ThreadForList[]; empty: string }) {
  if (list.length === 0) {
    return <div className="card max-w-2xl text-sm text-slate-400">{empty}</div>;
  }
  return (
    <div className="card p-0 divide-y divide-slate-800 max-w-3xl">
      {list.map((t) => {
        const meta = CHANNEL_META[t.channel];
        const last = t.messages[0];
        const preview = last
          ? `${last.direction === "outbound" ? "You: " : ""}${last.body}`
          : "";
        return (
          <RowModal
            key={t.key}
            onOpen={t.unread ? markThreadRead.bind(null, t.contactId, t.leadId, t.channel) : undefined}
            row={
              <div className="flex items-center gap-3">
                <span className="shrink-0">{meta.icon}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">
                    {t.name}
                    <span className="text-xs text-slate-500 font-normal ml-2">{meta.label}</span>
                  </p>
                  <p className="text-xs text-slate-400 truncate">{preview}</p>
                </div>
                <div className="text-right shrink-0">
                  {t.unread ? (
                    <span className="badge bg-amber-500/15 text-amber-300">Unread</span>
                  ) : t.awaiting ? (
                    <span className="badge bg-sky-500/15 text-sky-300">Read · reply due</span>
                  ) : (
                    <span className="badge bg-emerald-500/15 text-emerald-300">Replied</span>
                  )}
                  <p className="text-[11px] text-slate-500 mt-0.5">{formatDateTime(t.lastAt)}</p>
                </div>
              </div>
            }
          >
            <div className="card">
              <div className="flex items-center gap-2 flex-wrap">
                {meta.icon}
                {t.href ? (
                  <Link href={t.href} className="font-semibold text-orange-400 hover:underline">
                    {t.name}
                  </Link>
                ) : (
                  <span className="font-semibold">{t.name}</span>
                )}
                <span className="text-xs text-slate-500">{meta.label}</span>
                <span className="text-[11px] text-slate-500 ml-auto">
                  {formatDateTime(t.lastAt)}
                </span>
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
              <InboxReply
                channel={t.channel}
                contactId={t.contactId}
                leadId={t.leadId}
                phone={t.phone}
                revalidate="/inbox"
              />
            </div>
          </RowModal>
        );
      })}
    </div>
  );
}

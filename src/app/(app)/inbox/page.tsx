import Link from "next/link";
import { prisma, basePrisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import InboxReply from "@/components/InboxReply";
import AutoRefresh from "@/components/AutoRefresh";
import { contactName, formatDateTime } from "@/lib/format";

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
    lastAt: Date;
    messages: { id: string; direction: string | null; body: string; at: Date }[];
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
        awaiting: c.direction === "inbound", // comms are sorted desc: first seen = newest
        lastAt: c.occurredAt,
        messages: [],
      };
      threads.set(key, t);
    }
    if (t.messages.length < 8) {
      t.messages.push({ id: c.id, direction: c.direction, body: c.body, at: c.occurredAt });
    }
  }
  const threadList = [...threads.values()].sort(
    (a, b) => Number(b.awaiting) - Number(a.awaiting) || b.lastAt.getTime() - a.lastAt.getTime()
  );

  return (
    <div className="space-y-5">
      <AutoRefresh seconds={20} />
      <div>
        <h1 className="text-2xl font-bold">Social inbox</h1>
        <p className="text-sm text-slate-400 mt-1">
          Every WhatsApp, Messenger and Instagram conversation, tied to the customer&apos;s
          record — reply without leaving the CRM. New Google reviews land here too.
        </p>
      </div>

      <div className="grid lg:grid-cols-3 gap-6 items-start">
        <div className="lg:col-span-2 space-y-4">
          {threadList.length === 0 ? (
            <div className="card text-sm text-slate-400">
              No conversations yet. WhatsApp chats appear once the number is connected;
              Messenger and Instagram DMs start flowing when Meta approves the messaging
              permissions (app review).
            </div>
          ) : (
            threadList.map((t) => {
              const meta = CHANNEL_META[t.channel];
              return (
                <div key={t.key} className="card">
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
                    {t.awaiting && (
                      <span className="badge bg-amber-500/15 text-amber-300">awaiting reply</span>
                    )}
                    <span className="text-xs text-slate-500 ml-auto">
                      {formatDateTime(t.lastAt)}
                    </span>
                  </div>
                  <div className="mt-3 space-y-1.5">
                    {[...t.messages].reverse().map((m) => (
                      <div
                        key={m.id}
                        className={`max-w-[85%] rounded-lg px-3 py-1.5 text-sm whitespace-pre-wrap ${
                          m.direction === "inbound"
                            ? "bg-slate-800 text-slate-200"
                            : "bg-orange-600/20 text-orange-100 ml-auto"
                        }`}
                      >
                        {m.body}
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
              );
            })
          )}
        </div>

        <div className="card">
          <h2 className="font-semibold mb-1">Google reviews</h2>
          {reviews.length === 0 ? (
            <p className="text-sm text-slate-400">
              {placeId?.value
                ? "No reviews synced yet — the next cron run will pull them."
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
      </div>
    </div>
  );
}

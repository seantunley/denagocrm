import Link from "next/link";
import RowModal from "@/components/RowModal";
import InboxReply from "@/components/InboxReply";
import { markThreadRead, setThreadArchived } from "@/app/actions/communications";
import { formatDateTime } from "@/lib/format";
import type { InboxThread } from "@/lib/inboxThreads";

export const CHANNEL_META: Record<string, { label: string; icon: React.ReactNode }> = {
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

/**
 * The social-inbox thread list: a tappable row per conversation that opens the
 * full thread (messages + reply box + archive) in a modal. Shared by the full
 * /inbox and the /messages PWA. `revalidate` is the path replies refresh.
 */
export default function SocialThreadList({
  list,
  empty,
  revalidate = "/inbox",
}: {
  list: InboxThread[];
  empty: string;
  revalidate?: string;
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
                <form
                  action={setThreadArchived.bind(null, t.contactId, t.leadId, t.channel, !t.archived)}
                  className="ml-auto"
                >
                  <button type="submit" className="btn-secondary btn-sm">
                    {t.archived ? "Unarchive" : "Archive"}
                  </button>
                </form>
                <span className="text-[11px] text-slate-500">{formatDateTime(t.lastAt)}</span>
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
              {t.archived ? (
                <p className="mt-3 text-xs text-slate-500">
                  Archived — restore to reply.
                </p>
              ) : (
                <InboxReply
                  channel={t.channel}
                  contactId={t.contactId}
                  leadId={t.leadId}
                  phone={t.phone}
                  revalidate={revalidate}
                />
              )}
            </div>
          </RowModal>
        );
      })}
    </div>
  );
}

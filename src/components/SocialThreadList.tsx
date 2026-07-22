import Link from "next/link";
import { ChevronRight, MessageCircle } from "lucide-react";
import RowModal from "@/components/RowModal";
import InboxReply from "@/components/InboxReply";
import { markThreadRead, setThreadArchived } from "@/app/actions/communications";
import { formatDateTime } from "@/lib/format";
import type { InboxThread } from "@/lib/inboxThreads";
import { EmptyState, StatusPill } from "@/components/visual-system";

export const CHANNEL_META: Record<string, { label: string; icon: React.ReactNode }> = {
  whatsapp: {
    label: "WhatsApp",
    // eslint-disable-next-line @next/next/no-img-element
    icon: <img src="/branding/social-whatsapp.png" alt="WhatsApp" className="size-4 rounded-sm" />,
  },
  messenger: {
    label: "Messenger",
    // eslint-disable-next-line @next/next/no-img-element
    icon: <img src="/branding/social-facebook.png" alt="Messenger" className="size-4 rounded-sm" />,
  },
  instagram: {
    label: "Instagram",
    // eslint-disable-next-line @next/next/no-img-element
    icon: <img src="/branding/social-instagram.png" alt="Instagram" className="size-4 rounded-sm" />,
  },
};

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
    return <EmptyState icon={MessageCircle} title="No conversations here" description={empty} className="max-w-4xl" />;
  }

  return (
    <div className="max-w-5xl divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      {list.map((thread) => {
        const meta = CHANNEL_META[thread.channel];
        const last = thread.messages[0];
        const preview = last ? `${last.direction === "outbound" ? "You: " : ""}${last.body}` : "";
        const initials = thread.name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");

        return (
          <RowModal
            key={thread.key}
            onOpen={thread.unread ? markThreadRead.bind(null, thread.contactId, thread.leadId, thread.channel) : undefined}
            row={
              <div className="flex items-center gap-3 py-0.5">
                <span className="relative grid size-11 shrink-0 place-items-center rounded-xl border border-border bg-muted/50 text-sm font-semibold text-foreground">
                  {initials}
                  <span className="absolute -bottom-1 -right-1 grid size-5 place-items-center rounded-md border-2 border-card bg-card">{meta.icon}</span>
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2"><p className="truncate text-sm font-semibold text-foreground">{thread.name}</p><span className="shrink-0 text-[10px] text-muted-foreground">{meta.label}</span></div>
                  <p className={`mt-0.5 truncate text-xs ${thread.unread ? "font-medium text-foreground/80" : "text-muted-foreground"}`}>{preview || "No message preview"}</p>
                </div>
                <div className="hidden shrink-0 text-right sm:block">
                  {thread.unread ? <StatusPill tone="warning">Unread</StatusPill> : thread.awaiting ? <StatusPill tone="info">Reply due</StatusPill> : <StatusPill tone="success">Replied</StatusPill>}
                  <p className="mt-1 text-[10px] text-muted-foreground">{formatDateTime(thread.lastAt)}</p>
                </div>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground/40" />
              </div>
            }
          >
            <div>
              <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
                <span className="grid size-8 place-items-center rounded-lg border border-border bg-muted/50">{meta.icon}</span>
                <div className="min-w-0">
                  {thread.href ? <Link href={thread.href} className="font-semibold text-primary hover:underline">{thread.name}</Link> : <span className="font-semibold">{thread.name}</span>}
                  <p className="text-[11px] text-muted-foreground">{meta.label} · {formatDateTime(thread.lastAt)}</p>
                </div>
                <form action={setThreadArchived.bind(null, thread.contactId, thread.leadId, thread.channel, !thread.archived)} className="ml-auto">
                  <button type="submit" className="btn-secondary btn-sm">{thread.archived ? "Unarchive" : "Archive"}</button>
                </form>
              </div>

              <div className="mt-4 max-h-[52vh] space-y-2 overflow-y-auto rounded-2xl border border-border bg-background/45 p-3 overscroll-contain">
                {[...thread.messages].reverse().map((message) => (
                  <div
                    key={message.id}
                    className={`w-fit max-w-[82%] rounded-2xl px-3 py-2 text-sm leading-snug whitespace-pre-wrap ${message.direction === "inbound" ? "rounded-bl-md border border-border bg-muted text-foreground" : "ml-auto rounded-br-md bg-primary text-primary-foreground"}`}
                  >
                    {message.attachmentUrl && message.attachmentType === "image" ? (
                      <a href={message.attachmentUrl} target="_blank">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={message.attachmentUrl} alt="Attachment" className="my-1 max-h-48 rounded-md" />
                      </a>
                    ) : message.attachmentUrl && message.attachmentType === "audio" ? (
                      <audio controls src={message.attachmentUrl} className="my-1 max-w-full" />
                    ) : message.attachmentUrl && message.attachmentType === "video" ? (
                      <video controls src={message.attachmentUrl} className="my-1 max-h-48 rounded-md" />
                    ) : message.attachmentUrl ? (
                      <a href={message.attachmentUrl} target="_blank" className="underline">{message.body || "Attachment"}</a>
                    ) : null}
                    {(!message.attachmentUrl || (message.body && !message.body.startsWith("🖼") && !message.body.startsWith("🎤") && !message.body.startsWith("🎬") && !message.body.startsWith("📎"))) && message.body}
                  </div>
                ))}
              </div>

              {thread.archived ? <p className="mt-3 text-xs text-muted-foreground">Archived — restore this conversation to reply.</p> : <InboxReply channel={thread.channel} contactId={thread.contactId} leadId={thread.leadId} phone={thread.phone} revalidate={revalidate} />}
            </div>
          </RowModal>
        );
      })}
    </div>
  );
}

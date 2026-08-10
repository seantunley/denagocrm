import Link from "next/link";
import { ChevronRight, MessageCircle } from "lucide-react";
import RowModal from "@/components/RowModal";
import InboxReply from "@/components/InboxReply";
import { markThreadRead, setThreadArchived } from "@/app/actions/communications";
import { formatDateTime } from "@/lib/format";
import { threadCollaborationKey, type InboxThread, type ThreadCollaboration } from "@/lib/inboxThreads";
import ConversationCollab from "@/components/ConversationCollab";
import { EmptyState, StatusPill } from "@/components/visual-system";
import { RECEIPT_CHANNELS } from "@/lib/deliveryReceipts";
import { deliveryLabel, type DeliveryState } from "@/lib/messageDelivery";

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
  collaboration,
  staff = [],
  canCollaborate = false,
  viewerId,
  delivery,
}: {
  list: InboxThread[];
  empty: string;
  revalidate?: string;
  /** Assignment and notes per thread key. Absent → the panel is not rendered. */
  collaboration?: Map<string, ThreadCollaboration>;
  staff?: { id: string; name: string }[];
  canCollaborate?: boolean;
  /** The signed-in user, so the reply box can tell their own draft from a colleague's. */
  viewerId?: string | null;
  /**
   * How far each outbound message actually got, by Communication id. Absent for
   * messages sent before the durable queue existed — and for those the label
   * falls back to the receipt alone, which is all that was ever known about them.
   */
  delivery?: Map<string, DeliveryState>;
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
        const collabKey = threadCollaborationKey(thread);
        const collab = collabKey ? collaboration?.get(collabKey) : undefined;

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
                  <div className="mt-1.5 flex items-center gap-2 sm:hidden">
                    <StatusPill tone={thread.unread ? "warning" : thread.awaiting ? "info" : "success"}>
                      {thread.unread ? "Unread" : thread.awaiting ? "Reply due" : "Replied"}
                    </StatusPill>
                    <time dateTime={thread.lastAt.toISOString()} className="truncate text-[10px] text-muted-foreground">
                      {formatDateTime(thread.lastAt)}
                    </time>
                  </div>
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
              <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3 pr-12">
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
                  <div key={message.id} className="flex flex-col">
                  <div
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
                  {(() => {
                    // Under the bubble, and only on our own messages. Two things
                    // are being reported: whether the message reached the channel
                    // at all (the outbox) and what the CUSTOMER did with it (the
                    // receipt). Showing only the second is how a rejected message
                    // came to read "Sent ✓".
                    const label = deliveryLabel(
                      message,
                      RECEIPT_CHANNELS.has(thread.channel),
                      delivery?.get(message.id),
                    );
                    if (!label) return null;
                    const tone =
                      label.tone === "failed"
                        ? "text-red-400"
                        : label.tone === "pending"
                          ? "text-amber-300"
                          : "text-muted-foreground";
                    return (
                      <p className={`ml-auto mt-0.5 pr-1 text-right text-[10px] ${tone}`}>{label.text}</p>
                    );
                  })()}
                  </div>
                ))}
              </div>

              {/* Collaboration sits ABOVE the reply box: an internal note and a
                  customer reply are one slip apart, and the owner plus the
                  handover context is what you want to have read before typing. */}
              {collab ? <ConversationCollab collaboration={collab} staff={staff} canAct={canCollaborate} /> : null}

              {thread.archived ? <p className="mt-3 text-xs text-muted-foreground">Archived — restore this conversation to reply.</p> : <InboxReply channel={thread.channel} contactId={thread.contactId} leadId={thread.leadId} phone={thread.phone} revalidate={revalidate} conversationId={collab?.conversationId ?? null} draft={collab?.draft ?? null} viewerId={viewerId} />}
            </div>
          </RowModal>
        );
      })}
    </div>
  );
}

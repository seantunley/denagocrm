import Link from "next/link";
import { Car, MessageCircle } from "lucide-react";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import InboxReply from "@/components/InboxReply";
import InboxSplit, { type InboxSplitItem } from "@/components/InboxSplit";
import CreateQuoteButton from "@/components/quotes/CreateQuoteButton";
import DealStageSelect from "@/components/inbox/DealStageSelect";
import { markThreadRead, setThreadArchived } from "@/app/actions/communications";
import { markAndBlockConversationSpam, markConversationSpam } from "@/app/actions/inboundSpam";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { buttonVariants } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { storedFileSrc } from "@/lib/storedFileSrc";
import { threadCollaborationKey, type InboxThread, type ThreadCollaboration } from "@/lib/inboxThreads";
import ConversationCollab from "@/components/ConversationCollab";
import { EmptyState, StatusPill } from "@/components/visual-system";
import { RECEIPT_CHANNELS } from "@/lib/deliveryReceipts";
import { deliveryLabel, type DeliveryState } from "@/lib/messageDelivery";
import { voiceNoteTranscript } from "@/lib/voiceNoteReply";

// Keyed on the thread's own channel type, not `string`: a channel the inbox
// lists but this map lacks is then a compile error. It was `string`, Telegram
// threads were added to the inbox without an entry here, and the first Telegram
// conversation would have thrown on `meta.icon` and taken the whole list down.
export const CHANNEL_META: Record<InboxThread["channel"], { label: string; icon: React.ReactNode }> = {
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
  x: {
    label: "X",
    // eslint-disable-next-line @next/next/no-img-element
    icon: <img src="/branding/social-x.svg" alt="X" className="size-4 rounded-sm" />,
  },
  telegram: {
    label: "Telegram",
    // eslint-disable-next-line @next/next/no-img-element
    icon: <img src="/branding/social-telegram.svg" alt="Telegram" className="size-4 rounded-sm" />,
  },
};

/** The deal a conversation is on, as the inbox's right rail shows it (only deals the viewer may open). */
export type InboxDeal = {
  id: string;
  title: string;
  status: string;
  stage: { id: string; name: string; color: string };
  /** Open stages it can be moved to from the rail — empty when it isn't open or the viewer may not move stages. */
  stageOptions: { id: string; name: string }[];
  /** Formatted in the workspace's money format. */
  value: string | null;
  contactId: string | null;
  next: { summary: string; dueDate: Date } | null;
};

/** The customer's latest message (messages are newest first), when it is a transcribed voice note. */
function latestVoiceNoteId(thread: InboxThread): string | null {
  const latest = thread.messages.find((m) => m.direction === "inbound");
  return latest && voiceNoteTranscript(latest.body) ? latest.id : null;
}

/** The right rail: the deal beside the conversation — where it stands, what's next, and the next two moves. */
function DealRail({ thread, deal, canCreateQuote, canBookTestDrive }: { thread: InboxThread; deal: InboxDeal | undefined; canCreateQuote: boolean; canBookTestDrive: boolean }) {
  if (!deal) {
    return (
      <div className="text-sm">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">The deal</p>
        <p className="mt-2 text-muted-foreground">This conversation isn&apos;t on a deal you can open.</p>
        {thread.href ? <Link href={thread.href} className="mt-2 inline-block text-primary hover:underline">Open {thread.name}</Link> : null}
      </div>
    );
  }
  return (
    <div className="space-y-3 text-sm">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">The deal</p>
      <Link href={`/leads/${deal.id}`} className="block font-semibold text-primary hover:underline">{deal.title}</Link>
      <dl className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Stage</dt>
          <dd className="flex min-w-0 items-center gap-1.5">
            {deal.status === "open" && deal.stageOptions.length > 1
              ? <DealStageSelect key={deal.stage.id} leadId={deal.id} stageId={deal.stage.id} color={deal.stage.color} stages={deal.stageOptions} />
              : deal.status === "open"
              ? <><span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: deal.stage.color }} /><span className="truncate">{deal.stage.name}</span></>
              : <StatusPill tone={deal.status === "won" ? "success" : "neutral"}>{deal.status}</StatusPill>}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Value</dt>
          <dd className="tabular-nums">{deal.value ?? "Not set"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Next action</dt>
          <dd className="mt-0.5">
            {deal.next
              ? <>{deal.next.summary}<span className="block text-xs text-muted-foreground">{formatDateTime(deal.next.dueDate)}</span></>
              : <Link href={`/leads/${deal.id}?tab=activities&schedule=1`} className="text-primary hover:underline">None planned — add one</Link>}
          </dd>
        </div>
      </dl>
      <div className="flex flex-wrap gap-2">
        {canCreateQuote ? <CreateQuoteButton leadId={deal.id} /> : null}
        {canBookTestDrive ? (
          <Link href={`/test-drives?book=1&leadId=${deal.id}${deal.contactId ? `&contactId=${deal.contactId}` : ""}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            <Car />Book test drive
          </Link>
        ) : null}
      </div>
    </div>
  );
}

export default function SocialThreadList({
  list,
  empty,
  revalidate = "/inbox",
  collaboration,
  conversations,
  staff = [],
  canCollaborate = false,
  canMarkSpam = false,
  viewerId,
  delivery,
  deals,
  canCreateQuote = false,
  canBookTestDrive = false,
  metaRefused,
}: {
  /** Per channel, whether Meta is refusing this workspace's replies (lib/metaReplies.ts): those threads hand off. */
  metaRefused?: { messenger: boolean; instagram: boolean };
  /** Shows "Mark as spam" on WhatsApp, Messenger and Instagram conversations. The action checks the permission itself. */
  canMarkSpam?: boolean;
  list: InboxThread[];
  empty: string;
  revalidate?: string;
  /** Assignment and notes per thread key. Absent → the panel is not rendered. */
  collaboration?: Map<string, ThreadCollaboration>;
  /**
   * Conversation id per thread key, for callers that resolve the conversation
   * without the rest of the collaboration payload. A Messenger or Instagram reply
   * needs it: the server reads the delivery channel off that row.
   */
  conversations?: Map<string, string>;
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
  /** The deals the viewer may open, by lead id. Present → the deal rail is shown beside the conversation. */
  deals?: Map<string, InboxDeal>;
  canCreateQuote?: boolean;
  canBookTestDrive?: boolean;
}) {
  if (list.length === 0) {
    return <EmptyState icon={MessageCircle} title="No conversations here" description={empty} className="max-w-4xl" />;
  }

  const items: InboxSplitItem[] = list.map((thread) => {
    const meta = CHANNEL_META[thread.channel];
    const last = thread.messages[0];
    const preview = last ? `${last.direction === "outbound" ? "You: " : ""}${last.body}` : "";
    const initials = thread.name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
    const collabKey = threadCollaborationKey(thread);
    const collab = collabKey ? collaboration?.get(collabKey) : undefined;
    // Both sources are the same resolver's answer, so either will do; the
    // collaboration payload simply already carries it where it is loaded.
    const conversationId = collab?.conversationId ?? (collabKey ? conversations?.get(collabKey) : null) ?? null;

    return {
      key: thread.key,
      unread: thread.unread,
      markRead: thread.unread ? markThreadRead.bind(null, thread.contactId, thread.leadId, thread.channel) : undefined,
      row: (
        <div className="flex items-center gap-3">
          <span className="relative grid size-10 shrink-0 place-items-center rounded-xl border border-border bg-muted/50 text-sm font-semibold text-foreground">
            {initials}
            <span className="absolute -bottom-1 -right-1 grid size-5 place-items-center rounded-md border-2 border-card bg-card">{meta.icon}</span>
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className={`truncate text-sm text-foreground ${thread.unread ? "font-semibold" : "font-medium"}`}>{thread.name}</p>
              <time dateTime={thread.lastAt.toISOString()} className="ml-auto shrink-0 text-[10px] text-muted-foreground">{formatDateTime(thread.lastAt)}</time>
            </div>
            <p className={`mt-0.5 truncate text-xs ${thread.unread ? "font-medium text-foreground/80" : "text-muted-foreground"}`}>{preview || "No message preview"}</p>
            <div className="mt-1.5 flex items-center gap-2">
              <StatusPill tone={thread.unread ? "warning" : thread.awaiting ? "info" : "success"}>
                {thread.unread ? "Unread" : thread.awaiting ? "Reply due" : "Replied"}
              </StatusPill>
              <span className="text-[10px] text-muted-foreground">{meta.label}</span>
            </div>
          </div>
        </div>
      ),
      pane: (
        <div>
          <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
            <span className="grid size-8 place-items-center rounded-lg border border-border bg-muted/50">{meta.icon}</span>
            <div className="min-w-0">
              {thread.href ? <Link href={thread.href} className="font-semibold text-primary hover:underline">{thread.name}</Link> : <span className="font-semibold">{thread.name}</span>}
              <p className="text-[11px] text-muted-foreground">{meta.label} · {formatDateTime(thread.lastAt)}</p>
            </div>
            <div className="ml-auto flex flex-wrap gap-2">
              {canMarkSpam && !thread.archived && thread.contactId && ["whatsapp", "messenger", "instagram"].includes(thread.channel) ? (
                <>
                  <SaveForm action={markConversationSpam.bind(null, thread.contactId, thread.channel)}>
                    <SaveButton className="btn-secondary btn-sm" pendingLabel="…">Mark as spam</SaveButton>
                  </SaveForm>
                  <ConfirmActionDialog
                    trigger={<button type="button" className="btn-secondary btn-sm">Spam &amp; block sender</button>}
                    title={`Block ${thread.name}?`}
                    description="This archives the conversation as spam and blocks this sender on this channel. When Quarantine mode is enabled, future messages from them will be held even if genuine. You can remove the block in Spam → Sender decisions."
                    confirmLabel="Mark spam and block"
                    destructive
                    onConfirm={markAndBlockConversationSpam.bind(null, thread.contactId, thread.channel)}
                  />
                </>
              ) : null}
              {/* `e` (InboxSplit) submits this form. */}
              <div data-inbox-archive="">
                <SaveForm action={setThreadArchived.bind(null, thread.contactId, thread.leadId, thread.channel, !thread.archived)}>
                  <SaveButton className="btn-secondary btn-sm" pendingLabel="…">{thread.archived ? "Unarchive" : "Archive"}</SaveButton>
                </SaveForm>
              </div>
            </div>
          </div>

          <div className="mt-4 max-h-[52vh] space-y-2 overflow-y-auto rounded-2xl border border-border bg-background/45 p-3 overscroll-contain">
            {[...thread.messages].reverse().map((message) => (
              <div key={message.id} className="flex flex-col">
              <div
                className={`w-fit max-w-[82%] rounded-2xl px-3 py-2 text-sm leading-snug whitespace-pre-wrap ${message.direction === "inbound" ? "rounded-bl-md border border-border bg-muted text-foreground" : "ml-auto rounded-br-md bg-primary text-primary-foreground"}`}
              >
                {message.attachmentUrl && message.attachmentType === "image" ? (
                  <a href={storedFileSrc(message.attachmentUrl) ?? undefined} target="_blank">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={storedFileSrc(message.attachmentUrl) ?? undefined} alt="Attachment" className="my-1 max-h-48 rounded-md" />
                  </a>
                ) : message.attachmentUrl && message.attachmentType === "audio" ? (
                  <audio controls src={storedFileSrc(message.attachmentUrl) ?? undefined} className="my-1 max-w-full" />
                ) : message.attachmentUrl && message.attachmentType === "video" ? (
                  <video controls src={storedFileSrc(message.attachmentUrl) ?? undefined} className="my-1 max-h-48 rounded-md" />
                ) : message.attachmentUrl ? (
                  <a href={storedFileSrc(message.attachmentUrl) ?? undefined} target="_blank" className="underline">{message.body || "Attachment"}</a>
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

          {thread.archived ? <p className="mt-3 text-xs text-muted-foreground">Archived — restore this conversation to reply.</p> : <InboxReply channel={thread.channel} contactId={thread.contactId} leadId={thread.leadId} phone={thread.phone} revalidate={revalidate} conversationId={conversationId} draft={collab?.draft ?? null} viewerId={viewerId} voiceNoteId={latestVoiceNoteId(thread)} metaRefused={(thread.channel === "messenger" || thread.channel === "instagram") && Boolean(metaRefused?.[thread.channel])} />}
        </div>
      ),
      rail: deals
        ? <DealRail thread={thread} deal={thread.leadId ? deals.get(thread.leadId) : undefined} canCreateQuote={canCreateQuote} canBookTestDrive={canBookTestDrive} />
        : undefined,
    };
  });

  return <InboxSplit items={items} withRail={Boolean(deals)} />;
}

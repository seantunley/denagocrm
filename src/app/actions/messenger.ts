"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { canAccessContact, requirePermission } from "@/lib/permissions";
import { type DmPlatform } from "@/lib/messenger";
import { saveFile } from "@/lib/storage";
import {
  deliveryStateForMessages,
  enqueueStaffMessage,
  flushBotOutboxConversation,
  type AttachmentKind,
  type OutboxPayload,
  type StaffReplyResult,
} from "@/lib/botOutbox";
import { sendOutcomeMessage, staffReplyIdempotencyKey } from "@/lib/messageDelivery";

const ATTACH_KIND = (mime: string): AttachmentKind =>
  mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : mime.startsWith("video/") ? "video" : "file";

/** What the timeline shows for an attachment with no caption of its own. */
const ATTACHMENT_BODY: Record<AttachmentKind, string> = {
  image: "🖼 Image",
  audio: "🎤 Voice note",
  video: "🎬 Video",
  file: "📎 File",
};

export type DmState = { ok?: string; error?: string };

/** Narrows a stored/declared channel string to a platform we can actually send on. */
function isDmPlatform(value: string): value is DmPlatform {
  return value === "messenger" || value === "instagram";
}

export async function sendDmReply(
  _prev: DmState | undefined,
  formData: FormData
): Promise<DmState> {
  const user = await requirePermission("inbox.reply");
  const contactId = String(formData.get("contactId") ?? "").trim();
  const text = String(formData.get("text") ?? "").trim();
  const file = formData.get("file") as File | null;
  const hasFile = file && typeof file === "object" && file.size > 0;
  if (!contactId || (!text && !hasFile)) return { error: "Type a message or attach a file." };
  if (!(await canAccessContact(user, contactId))) return { error: "Customer access denied." };

  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact) return { error: "Contact not found." };

  /**
   * The THREAD decides the channel — never the contact's identity set.
   *
   * This used to read `contact.instagramId && !contact.messengerPsid`, so a
   * customer who had messaged on both platforms always resolved to Messenger:
   * a reply typed into an Instagram thread was delivered over Messenger, to the
   * same person, on a channel they were not looking at.
   *
   * The Conversation is the authority when we have one. Otherwise the channel the
   * reply box was rendered for is accepted, but only after it is checked against
   * the identity the contact actually has — the RECIPIENT is always resolved here
   * from that channel, never supplied by the client.
   */
  const conversationId = String(formData.get("conversationId") ?? "").trim();
  const declaredChannel = String(formData.get("channel") ?? "").trim();
  let platform: DmPlatform | null = null;

  if (conversationId) {
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, contactId },
      select: { channel: true },
    });
    if (!conversation) return { error: "That conversation does not belong to this customer." };
    if (!isDmPlatform(conversation.channel)) {
      return { error: `This is a ${conversation.channel} conversation, not a Messenger or Instagram one.` };
    }
    platform = conversation.channel;
  } else if (isDmPlatform(declaredChannel)) {
    platform = declaredChannel;
  }
  if (!platform) return { error: "Reply channel could not be determined — reopen the conversation and try again." };

  const recipientId = platform === "instagram" ? contact.instagramId : contact.messengerPsid;
  // Deliberately no fallback to the other platform: sending to the wrong channel
  // is worse than not sending, because the customer sees nothing and staff see
  // "Sent ✓".
  if (!recipientId) {
    return { error: `This contact has no ${platform === "instagram" ? "Instagram" : "Messenger"} identity, so the reply cannot be delivered there.` };
  }

  const compositionId = String(formData.get("compositionId") ?? "").trim();
  if (!compositionId) return { error: "This reply is missing its send key — reload the page and try again." };

  /**
   * The upload is the one thing that cannot join the transaction.
   *
   * It is an external side effect, so it happens first and its only failure mode
   * is an orphaned blob — cheap, and invisible to the customer. Everything after
   * it is durable.
   */
  let attachmentUrl: string | null = null;
  let attachmentKind: AttachmentKind | null = null;
  if (hasFile) {
    if (file.size > 4 * 1024 * 1024) {
      return { error: "File too big — 4MB max here. For larger files, share a Library link instead." };
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    attachmentUrl = await saveFile(buffer, file.name || "attachment", file.type || "application/octet-stream");
    attachmentKind = ATTACH_KIND(file.type || "");
  }

  /**
   * Record and queue, then deliver — never the other way round.
   *
   * This path called the provider FIRST and wrote the CRM record afterwards,
   * exactly as the WhatsApp path used to. A provider success followed by a failed
   * insert left the customer holding a message the CRM had no record of: staff
   * were told it failed, retried, and the customer received it twice. With an
   * attachment it was worse — the file was sent, then the text send failed, and
   * the retry re-sent BOTH, so the customer got the attachment twice.
   *
   * An attachment and its accompanying text are two provider sends, because Meta
   * has no single call that carries both. They are therefore two queued messages
   * and two timeline rows, which is also what the customer actually receives —
   * and it means each one is independently deduplicated, retried and reported.
   * A retry after a half-succeeded submission resends only the half that failed.
   *
   * Ordering is the outbox's: rows sharing a conversation are claimed oldest
   * first, and a failure blocks what was queued behind it, so the caption can
   * never arrive before the file it describes.
   */
  const outgoing: { message: OutboxPayload; body: string; url: string | null; kind: string | null }[] = [];
  if (attachmentUrl && attachmentKind) {
    outgoing.push({
      message: { type: "attachment", kind: attachmentKind, url: attachmentUrl },
      body: ATTACHMENT_BODY[attachmentKind],
      url: attachmentUrl,
      kind: attachmentKind,
    });
  }
  if (text) outgoing.push({ message: { type: "text", text }, body: text, url: null, kind: null });

  const label = platform === "instagram" ? "Instagram" : "Messenger";
  const results: StaffReplyResult[] = [];
  for (const part of outgoing) {
    const queued = await enqueueStaffMessage({
      channel: platform,
      key: recipientId,
      message: part.message,
      clientIdempotencyKey: staffReplyIdempotencyKey({
        compositionId,
        channel: platform,
        key: recipientId,
        actorId: user.id,
        contactId,
        leadId: null,
        body: part.body,
        attachmentUrl: part.url,
      }),
      body: part.body,
      attachmentUrl: part.url,
      attachmentType: part.kind,
      contactId,
      actorId: user.id,
      // Ownership, history, the delivery intent and the trail commit together.
      // The second call's pause and fence are idempotent, and the fence only
      // touches BOT-origin rows, so it can never withdraw the first part of this
      // very reply.
      audit: {
        action: `${platform}.sent`,
        summary: `${label} reply sent: “${part.body.slice(0, 60)}${part.body.length > 60 ? "…" : ""}”`,
        user,
      },
    });
    if (queued.outcome === "conflict") {
      return { error: "This reply could not be matched to its send — reload the conversation and try again." };
    }
    results.push(queued);
  }

  // Best-effort immediate drain so the reply leaves now rather than on the next
  // cron tick; the worker owns retries, ordering and dead-lettering if it fails.
  await flushBotOutboxConversation(platform, recipientId).catch(() => {});

  revalidatePath(String(formData.get("revalidate") ?? "/inbox"));

  /**
   * The truth about what was queued, read back after the drain — never a blanket
   * "Sent ✓", which is what this returned even when the provider had refused.
   *
   * With two parts, the WORST outcome is the answer: an attachment that did not
   * arrive is not made acceptable by the caption that did.
   */
  const ids = results.map((r) => r.communicationId).filter((id): id is string => Boolean(id));
  if (!ids.length) return { ok: "Queued — sending…" };
  const states = await deliveryStateForMessages(ids);
  const outcomes = ids.map((id) => sendOutcomeMessage(states.get(id)));
  return outcomes.find((outcome) => outcome.error) ?? outcomes[outcomes.length - 1];
}

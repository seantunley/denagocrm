"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { canAccessContact, requirePermission } from "@/lib/permissions";
import { type DmPlatform } from "@/lib/messenger";
import { saveFile } from "@/lib/storage";
import { customerRecordTenantId } from "@/lib/customerRecordTenant";
import {
  deliveryStateForMessages,
  enqueueStaffReply,
  flushBotOutboxConversation,
  type AttachmentKind,
  type OutboxPayload,
} from "@/lib/botOutbox";
import { attachmentDigest, sendOutcomeMessage, staffReplyIdempotencyKey } from "@/lib/messageDelivery";
import { canServeOutboundMedia } from "@/lib/outboundMedia";
import { sendXDirectMessage } from "@/lib/x";

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

/** Narrows a stored conversation channel to a platform we can actually send on. */
function isDmPlatform(value: string): value is DmPlatform {
  return value === "messenger" || value === "instagram" || value === "x";
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
   * The stored CONVERSATION decides the channel — never the contact's identity
   * set, and never the browser.
   *
   * This used to read `contact.instagramId && !contact.messengerPsid`, so a
   * customer who had messaged on both platforms always resolved to Messenger:
   * a reply typed into an Instagram thread was delivered over Messenger, to the
   * same person, on a channel they were not looking at.
   *
   * A posted `channel` field would fix that thread but not the authority problem:
   * anyone holding inbox.reply could then pick which platform a dual-identity
   * customer received on, and the audit trail would record whichever they chose.
   * So the conversation id is REQUIRED, it is re-read here, and both the channel
   * and the recipient come out of that row. There is no fallback — an unresolved
   * thread refuses rather than guessing.
   */
  const conversationId = String(formData.get("conversationId") ?? "").trim();
  if (!conversationId) {
    return { error: "This thread has no conversation to reply on yet — reopen it and try again." };
  }
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, contactId },
    select: { channel: true },
  });
  if (!conversation) return { error: "That conversation does not belong to this customer." };
  if (!isDmPlatform(conversation.channel)) {
    return { error: `This is a ${conversation.channel} conversation, not a Messenger or Instagram one.` };
  }
  const platform: DmPlatform = conversation.channel;
  const tenantId = await customerRecordTenantId({ contactId });

  const recipientId = platform === "instagram" ? contact.instagramId : platform === "x" ? contact.xUserId : contact.messengerPsid;
  // Deliberately no fallback to the other platform: sending to the wrong channel
  // is worse than not sending, because the customer sees nothing and staff see
  // "Sent ✓".
  if (!recipientId) {
    return { error: `This contact has no ${platform === "instagram" ? "Instagram" : platform === "x" ? "X" : "Messenger"} identity, so the reply cannot be delivered there.` };
  }

  if (platform === "x") {
    if (hasFile) return { error: "X attachments are not supported yet — send text or a link." };
    const result = await sendXDirectMessage(recipientId, text);
    if (!result.ok) return { error: result.error ?? "X refused the message." };
    await prisma.communication.create({ data: {
      type: "x", direction: "outbound", body: text, contactId, userId: user.id,
      messageId: result.providerMessageId ?? null, tenantId,
    }});
    revalidatePath(String(formData.get("revalidate") ?? "/inbox"));
    return { ok: "Sent via X ✓" };
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
  let attachmentContentType: string | null = null;
  let fileDigest: string | null = null;
  if (hasFile) {
    if (file.size > 4 * 1024 * 1024) {
      return { error: "File too big — 4MB max here. For larger files, share a Library link instead." };
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    attachmentContentType = file.type || "application/octet-stream";
    // Taken from the BYTES, before they are stored anywhere, so it is the same
    // on every submission of the same file.
    fileDigest = attachmentDigest(buffer);
    // The CONTACT this reply is addressed to owns the attachment — the same record
    // the Communication rows queued below claim, via the same rule. Not the
    // sender's session: a staff member replying into another workspace's thread
    // would otherwise file that thread's media under their own prefix.
    attachmentUrl = await saveFile(
      buffer,
      file.name || "attachment",
      attachmentContentType,
      tenantId,
    );
    attachmentKind = ATTACH_KIND(file.type || "");
    /**
     * ASKED, NOT MINTED.
     *
     * Meta does not accept bytes on its send endpoint — it accepts a URL and
     * fetches it anonymously. `saveFile` returns a publicly readable blob URL on
     * Vercel, a PRIVATE blob URL when BLOB_PRIVATE is on, and a BARE FILENAME
     * when self-hosted; the last two produce a message the CRM accepts, shows in
     * the timeline, retries, and never delivers. So the person is told NOW,
     * which is something they can act on — send the text, or share a link.
     *
     * But only the QUESTION is asked here. The URL itself is a short-lived
     * bearer credential and belongs to the delivery attempt, not to the queue:
     * see the `ref` field on the attachment payload.
     */
    if (!canServeOutboundMedia(attachmentUrl)) {
      return {
        error:
          "This deployment cannot serve attachments to Messenger or Instagram — set NEXT_PUBLIC_APP_URL to a public https address, or send a link instead.",
      };
    }
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
   * and each is independently deduplicated, retried and reported.
   *
   * They are ACCEPTED as one operation, though. Two separate calls would leave a
   * state where the file was queued and the caption was not: the outbox then
   * delivers a bare attachment with no explanation, and the caption arrives only
   * if the person happens to retry. Handing both parts to one transaction removes
   * that state rather than making it recoverable.
   *
   * Ordering is the outbox's: parts share a batch and carry a sequence, and a
   * conversation is claimed by (createdAt, sequence, id) with a failure blocking
   * what was queued behind it — so the caption can never arrive before the file
   * it describes.
   */
  const label = platform === "instagram" ? "Instagram" : "Messenger";
  const part = (
    message: OutboxPayload,
    body: string,
    url: string | null,
    kind: string | null,
    digest: string | null,
  ) => ({
    message,
    body,
    attachmentUrl: url,
    attachmentType: kind,
    clientIdempotencyKey: staffReplyIdempotencyKey({
      compositionId,
      channel: platform,
      key: recipientId,
      actorId: user.id,
      contactId,
      leadId: null,
      body,
      // The DIGEST, not the URL. saveFile mints a fresh random name on every
      // call, so a resubmission of the same file uploads it again and gets a
      // different URL. Keying on that made the key unstable in precisely the
      // situation it exists for — an ambiguous failure followed by a retry —
      // and the customer received the attachment twice.
      attachmentDigest: digest,
    }),
  });

  const parts = [
    // The queued payload carries the DURABLE storage ref, not a URL. The worker
    // mints a fresh provider-fetchable one on each attempt, so a reply that waits
    // out an outage still arrives. The timeline row keeps the same ref, which is
    // what the inbox renders through its own authenticated route.
    ...(attachmentUrl && attachmentKind && fileDigest
      ? [
          part(
            {
              type: "attachment",
              kind: attachmentKind,
              ref: attachmentUrl,
              contentType: attachmentContentType ?? "application/octet-stream",
              digest: fileDigest,
            },
            ATTACHMENT_BODY[attachmentKind],
            attachmentUrl,
            attachmentKind,
            fileDigest,
          ),
        ]
      : []),
    ...(text ? [part({ type: "text", text }, text, null, null, null)] : []),
  ];

  const queued = await enqueueStaffReply({
    channel: platform,
    key: recipientId,
    parts,
    contactId,
    actorId: user.id,
    audit: {
      action: `${platform}.sent`,
      summary: `${label} reply sent: “${(text || ATTACHMENT_BODY[attachmentKind ?? "file"]).slice(0, 60)}${text.length > 60 ? "…" : ""}”`,
      user,
    },
  });

  if (queued.outcome === "conflict") {
    return { error: "This reply could not be matched to its send — reload the conversation and try again." };
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
  const ids = queued.parts.map((p) => p.communicationId).filter((id): id is string => Boolean(id));
  if (!ids.length) return { ok: "Queued — sending…" };
  const states = await deliveryStateForMessages(ids);
  const outcomes = ids.map((id) => sendOutcomeMessage(states.get(id)));
  return outcomes.find((outcome) => outcome.error) ?? outcomes[outcomes.length - 1];
}

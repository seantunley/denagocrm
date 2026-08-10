"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { canAccessContact, requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { sendDirectMessage, sendDirectAttachment, type DmPlatform } from "@/lib/messenger";
import { saveFile } from "@/lib/storage";
import { pauseBotConversation } from "@/lib/botConversationControl";

const ATTACH_KIND = (mime: string): "image" | "audio" | "video" | "file" =>
  mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : mime.startsWith("video/") ? "video" : "file";

export type DmState = { ok?: string; error?: string };

/** Narrows a stored conversation channel to a platform we can actually send on. */
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

  const recipientId = platform === "instagram" ? contact.instagramId : contact.messengerPsid;
  // Deliberately no fallback to the other platform: sending to the wrong channel
  // is worse than not sending, because the customer sees nothing and staff see
  // "Sent ✓".
  if (!recipientId) {
    return { error: `This contact has no ${platform === "instagram" ? "Instagram" : "Messenger"} identity, so the reply cannot be delivered there.` };
  }

  let attachmentUrl: string | null = null;
  let attachmentType: "image" | "audio" | "video" | "file" | null = null;
  if (hasFile) {
    if (file.size > 4 * 1024 * 1024) {
      return { error: "File too big — 4MB max here. For larger files, share a Library link instead." };
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    attachmentUrl = await saveFile(buffer, file.name || "attachment", file.type || "application/octet-stream");
    attachmentType = ATTACH_KIND(file.type || "");
    const sent = await sendDirectAttachment(platform, recipientId, {
      type: attachmentType,
      url: attachmentUrl,
    });
    if (!sent.ok) return { error: sent.error };
  }

  if (text) {
    const result = await sendDirectMessage(platform, recipientId, text);
    if (!result.ok) return { error: result.error };
  }

  await prisma.communication.create({
    data: {
      type: platform,
      direction: "outbound",
      body: text || (attachmentType === "image" ? "🖼 Image" : "📎 File"),
      attachmentUrl,
      attachmentType,
      contactId,
      userId: user.id,
    },
  });
  await pauseBotConversation({ channel: platform, key: recipientId }, 12);
  await logAudit({
    action: `${platform}.sent`,
    summary: `${platform === "instagram" ? "Instagram" : "Messenger"} reply sent: “${text.slice(0, 60)}${text.length > 60 ? "…" : ""}”`,
    contactId,
    user,
  });
  revalidatePath(String(formData.get("revalidate") ?? "/inbox"));
  return { ok: "Sent ✓" };
}

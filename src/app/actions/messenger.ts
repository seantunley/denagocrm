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
  const platform: DmPlatform = contact.instagramId && !contact.messengerPsid ? "instagram" : "messenger";
  const recipientId = platform === "instagram" ? contact.instagramId : contact.messengerPsid;
  if (!recipientId) return { error: "This contact has no Messenger/Instagram identity." };

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

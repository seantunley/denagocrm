"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { sendDirectMessage, type DmPlatform } from "@/lib/messenger";

export type DmState = { ok?: string; error?: string };

/** Reply to a Messenger / Instagram DM from the CRM. */
export async function sendDmReply(
  _prev: DmState | undefined,
  formData: FormData
): Promise<DmState> {
  const user = await requireUser();
  const contactId = String(formData.get("contactId") ?? "").trim();
  const text = String(formData.get("text") ?? "").trim();
  if (!contactId || !text) return { error: "Message is required." };

  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact) return { error: "Contact not found." };

  const platform: DmPlatform = contact.instagramId && !contact.messengerPsid ? "instagram" : "messenger";
  const recipientId = platform === "instagram" ? contact.instagramId : contact.messengerPsid;
  if (!recipientId) return { error: "This contact has no Messenger/Instagram identity." };

  const result = await sendDirectMessage(platform, recipientId, text);
  if (!result.ok) return { error: result.error };

  await prisma.communication.create({
    data: {
      type: platform,
      direction: "outbound",
      body: text,
      contactId,
      userId: user.id,
    },
  });
  await logAudit({
    action: `${platform}.sent`,
    summary: `${platform === "instagram" ? "Instagram" : "Messenger"} reply sent: “${text.slice(0, 60)}${text.length > 60 ? "…" : ""}”`,
    contactId,
    user,
  });
  revalidatePath(String(formData.get("revalidate") ?? "/inbox"));
  return { ok: "Sent ✓" };
}

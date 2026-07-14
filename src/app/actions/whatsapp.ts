"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { canAccessContact, canAccessLead, requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { sendWhatsAppText, waDigits } from "@/lib/whatsapp";

export type WaState = { ok?: string; error?: string };

export async function sendWhatsAppMessage(
  _prev: WaState | undefined,
  formData: FormData
): Promise<WaState> {
  const user = await requirePermission("inbox.reply");
  const phone = String(formData.get("phone") ?? "").trim();
  const text = String(formData.get("text") ?? "").trim();
  const contactId = String(formData.get("contactId") ?? "").trim() || null;
  const leadId = String(formData.get("leadId") ?? "").trim() || null;
  if (!phone || !text) return { error: "Message is required." };
  if (contactId && !(await canAccessContact(user, contactId))) return { error: "Customer access denied." };
  if (leadId && !(await canAccessLead(user, leadId))) return { error: "Lead access denied." };

  const digits = waDigits(phone);
  const result = await sendWhatsAppText(digits, text);
  if (!result.ok) return { error: result.error };

  await prisma.communication.create({
    data: {
      type: "whatsapp",
      direction: "outbound",
      body: text,
      contactId,
      leadId,
      userId: user.id,
    },
  });
  await logAudit({
    action: "whatsapp.sent",
    summary: `WhatsApp sent to +${digits}: “${text.slice(0, 60)}${text.length > 60 ? "…" : ""}”`,
    contactId,
    leadId,
    user,
  });
  revalidatePath(String(formData.get("revalidate") ?? "/"));
  return { ok: "Sent ✓" };
}

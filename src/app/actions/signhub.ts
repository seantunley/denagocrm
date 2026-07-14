"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { dispatchRequest, notifyRecipient } from "@/lib/signing/dispatch";
import { logSignEvent } from "@/lib/signing/events";

export async function sendRequest(requestId: string): Promise<{ ok: boolean; notified?: number; error?: string }> {
  const user = await requireOwner();
  const req = await prisma.signatureRequest.findUnique({ where: { id: requestId }, include: { recipients: true } });
  if (!req || req.deletedAt) return { ok: false, error: "Not found" };
  if (req.status === "completed" || req.status === "voided") return { ok: false, error: "This request is closed." };
  const reachable = req.recipients.filter((r) => r.role !== "viewer" && (r.email || r.phone));
  if (reachable.length === 0) return { ok: false, error: "Add an email or phone to at least one signer first." };

  const { notified } = await dispatchRequest(requestId);
  await logAudit({ action: "signing.send", summary: `Sent “${req.title}” for signing`, entityType: "SignatureRequest", entityId: requestId, user });
  revalidatePath("/signatures");
  revalidatePath(`/signatures/${requestId}`);
  return { ok: true, notified };
}

export async function remindRecipient(recipientId: string): Promise<{ ok: boolean }> {
  const user = await requireOwner();
  const r = await prisma.signatureRecipient.findUnique({ where: { id: recipientId } });
  if (!r) return { ok: false };
  await notifyRecipient(recipientId, { reminder: true });
  await logAudit({ action: "signing.remind", summary: `Reminded ${r.name}`, entityType: "SignatureRecipient", entityId: recipientId, user });
  revalidatePath(`/signatures/${r.requestId}`);
  return { ok: true };
}

export async function voidRequest(requestId: string, reason?: string): Promise<{ ok: boolean }> {
  const user = await requireOwner();
  const req = await prisma.signatureRequest.findUnique({ where: { id: requestId } });
  if (!req) return { ok: false };
  await prisma.signatureRequest.update({ where: { id: requestId }, data: { status: "voided" } });
  await logSignEvent(requestId, { type: "voided", actor: `Denago: ${user.name}`, metadata: { reason: reason ?? "" } });
  await logAudit({ action: "signing.void", summary: `Voided “${req.title}”`, entityType: "SignatureRequest", entityId: requestId, user });
  revalidatePath("/signatures");
  revalidatePath(`/signatures/${requestId}`);
  return { ok: true };
}

/** Update recipient contact details before sending (from the dashboard). */
export async function updateRecipientContact(recipientId: string, patch: { email?: string; phone?: string }): Promise<{ ok: boolean }> {
  await requireOwner();
  const r = await prisma.signatureRecipient.findUnique({ where: { id: recipientId } });
  if (!r) return { ok: false };
  await prisma.signatureRecipient.update({ where: { id: recipientId }, data: { email: patch.email ?? r.email, phone: patch.phone ?? r.phone } });
  revalidatePath(`/signatures/${r.requestId}`);
  return { ok: true };
}

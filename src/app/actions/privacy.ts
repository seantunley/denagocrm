"use server";

import { revalidatePath } from "next/cache";
import { prisma, basePrisma } from "@/lib/db";
import { requireContactAccess } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { CONSENT_TYPES } from "@/lib/consent";
import { deleteCustomValuesFor } from "@/lib/customFields";

export async function recordConsent(contactId: string, formData: FormData) {
  const user = await requireContactAccess(contactId, "contacts.edit");
  const type = String(formData.get("type") ?? "");
  const granted = String(formData.get("granted") ?? "") === "granted";
  if (!CONSENT_TYPES.some((item) => item.id === type)) return;

  await prisma.consentRecord.create({
    data: {
      contactId,
      type,
      granted,
      source: String(formData.get("source") ?? "admin").trim() || "admin",
      note: String(formData.get("note") ?? "").trim() || null,
      createdById: user.id,
    },
  });
  if (type === "marketing") {
    await prisma.contact.update({ where: { id: contactId }, data: { marketingOptOut: !granted } });
  }
  await logAudit({
    action: "consent.recorded",
    summary: `Consent ${granted ? "granted" : "withdrawn"} — ${type}`,
    contactId,
    user,
  });
  revalidatePath(`/contacts/${contactId}`);
}

/**
 * POPIA erasure is intentionally tied to contact deletion authority and record
 * scope. Records remain for warranty, safety and audit, but personal identifiers
 * are redacted and consent is withdrawn.
 */
export async function anonymizeContact(contactId: string) {
  const user = await requireContactAccess(contactId, "contacts.delete");
  // POPIA erasure is irreversible — keep it owner-only until the permission-based
  // de-escalation is explicitly signed off (flagged in review of PR #12).
  if (user.role !== "owner") throw new Error("Only an owner can anonymise a contact (POPIA erasure).");
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact) return;

  await prisma.contact.update({
    where: { id: contactId },
    data: {
      firstName: "Redacted",
      lastName: null,
      company: null,
      email: null,
      phone: null,
      whatsapp: null,
      address: null,
      suburb: null,
      city: null,
      province: null,
      postalCode: null,
      notes: null,
      marketingOptOut: true,
      deletedAt: new Date(),
      deletedByName: user.name,
      deleteReason: "POPIA erasure request",
    },
  });
  await prisma.lead.updateMany({
    where: { contactId },
    data: { name: "Redacted", email: null, phone: null },
  });
  // Custom-field values can hold PII (e.g. ID number) — erase them too, for the
  // contact and for each of its leads, quotes and cases. These key on the record
  // id with no FK, so nothing cascades; gather ids via basePrisma so trashed
  // (soft-deleted) records' custom PII is erased as well. Erasure must be total.
  const [leadIds, quoteIds, caseIds] = await Promise.all([
    basePrisma.lead.findMany({ where: { contactId }, select: { id: true } }).then((r) => r.map((x) => x.id)),
    basePrisma.quote.findMany({ where: { contactId }, select: { id: true } }).then((r) => r.map((x) => x.id)),
    basePrisma.customerCase.findMany({ where: { contactId }, select: { id: true } }).then((r) => r.map((x) => x.id)),
  ]);
  await deleteCustomValuesFor("contact", [contactId]);
  await deleteCustomValuesFor("lead", leadIds);
  await deleteCustomValuesFor("quote", quoteIds);
  await deleteCustomValuesFor("case", caseIds);
  await prisma.consentRecord.create({
    data: {
      contactId,
      type: "data_processing",
      granted: false,
      source: "admin",
      note: "Erasure request",
      createdById: user.id,
    },
  });
  await logAudit({
    action: "privacy.erased",
    summary: "POPIA erasure — personal data redacted for a contact",
    contactId,
    user,
  });
  revalidatePath(`/contacts/${contactId}`);
}

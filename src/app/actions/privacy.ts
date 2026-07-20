"use server";

import { revalidatePath } from "next/cache";
import { prisma, basePrisma } from "@/lib/db";
import { requireContactAccess } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { CONSENT_TYPES } from "@/lib/consent";
import { type CustomEntity } from "@/lib/customFields";

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

  // Erasure runs in ONE interactive transaction and is all-or-nothing. Two things
  // matter for completeness:
  //   1. We lock the contact FOR UPDATE first. A new child (lead/quote/case)
  //      inserted against this contact takes an FK KEY-SHARE lock on its row,
  //      which now blocks until we commit — so no child can slip in AFTER we
  //      gather ids but before we finish, and escape the custom-field wipe.
  //   2. Child ids are gathered INSIDE the transaction (post-lock), and the
  //      redaction, custom-value deletes and withdrawal-of-consent record all
  //      commit together — never a half-anonymised contact without consent proof.
  // Runs on the base client (tx) so soft-deleted leads are redacted too. Custom
  // values key on the record id with no FK, so nothing cascades — we erase them
  // for the contact and each of its leads, quotes and cases explicitly.
  await basePrisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Contact" WHERE "id" = ${contactId} FOR UPDATE`;

    const [leadIds, quoteIds, caseIds] = await Promise.all([
      tx.lead.findMany({ where: { contactId }, select: { id: true } }).then((r) => r.map((x) => x.id)),
      tx.quote.findMany({ where: { contactId }, select: { id: true } }).then((r) => r.map((x) => x.id)),
      tx.customerCase.findMany({ where: { contactId }, select: { id: true } }).then((r) => r.map((x) => x.id)),
    ]);

    await tx.contact.update({
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
    await tx.lead.updateMany({
      where: { contactId },
      data: { name: "Redacted", email: null, phone: null },
    });

    const erase = async (ids: string[], entity: CustomEntity) => {
      if (ids.length) {
        await tx.customFieldValue.deleteMany({ where: { recordId: { in: ids }, def: { entity } } });
      }
    };
    await erase([contactId], "contact");
    await erase(leadIds, "lead");
    await erase(quoteIds, "quote");
    await erase(caseIds, "case");

    await tx.consentRecord.create({
      data: {
        contactId,
        type: "data_processing",
        granted: false,
        source: "admin",
        note: "Erasure request",
        createdById: user.id,
      },
    });
  });
  await logAudit({
    action: "privacy.erased",
    summary: "POPIA erasure — personal data redacted for a contact",
    contactId,
    user,
  });
  revalidatePath(`/contacts/${contactId}`);
}

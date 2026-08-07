"use server";

import { asActionResult, ActionRefusal, refuse } from "@/lib/actionResult";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { withTenantWrite } from "@/lib/tenantWrite";
import { logAudit } from "@/lib/audit";
import { softDeleteRecord } from "@/lib/trash";
import { contactName } from "@/lib/format";
import { requirePermission, requireContactAccess } from "@/lib/permissions";

function contactData(formData: FormData) {
  const str = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    return v === "" ? null : v;
  };
  return {
    isCompany: formData.get("isCompany") === "on",
    firstName: String(formData.get("firstName") ?? "").trim(),
    lastName: str("lastName"),
    company: str("company"),
    email: str("email"),
    phone: str("phone"),
    whatsapp: str("whatsapp"),
    address: str("address"),
    suburb: str("suburb"),
    city: str("city"),
    province: str("province"),
    postalCode: str("postalCode"),
    source: str("source"),
    notes: str("notes"),
    ownerId: str("ownerId"),
    marketingOptOut: formData.get("marketingOptOut") === "on",
  };
}

const TAG_PALETTE = [
  "#ea580c", "#2563eb", "#059669", "#7c3aed",
  "#db2777", "#d97706", "#0891b2", "#dc2626",
];

function tagColor(name: string) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  return TAG_PALETTE[hash % TAG_PALETTE.length];
}

function parseTags(formData: FormData) {
  return [
    ...new Set(
      String(formData.get("tags") ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    ),
  ];
}

// Tag upsert + join-row insert INSIDE the caller's tenant transaction (tx). Tags
// are per-tenant unique on (tenantId, name); both the Tag and the _ContactToTag row
// are created/linked with the same owning tenant the contact gets, so no
// cross-tenant tag can be attached.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function upsertContactTagTx(tx: any, tenantId: string, name: string): Promise<string> {
  const existing = await tx.tag.findFirst({ where: { name, tenantId } });
  if (existing) return existing.id;
  const created = await tx.tag.create({ data: { name, color: tagColor(name), tenantId } });
  return created.id;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function syncContactTagsTx(tx: any, tenantId: string, contactId: string, tagNames: string[]): Promise<void> {
  for (const name of tagNames) {
    const tagId = await upsertContactTagTx(tx, tenantId, name);
    await tx.$executeRaw`INSERT INTO "_ContactToTag" ("A","B") VALUES (${contactId},${tagId}) ON CONFLICT DO NOTHING`;
  }
}

export async function createContact(formData: FormData) {
  return asActionResult(async () => {
    const user = await requirePermission("contacts.create");
    const data = contactData(formData);
    if (!data.firstName) throw new ActionRefusal("Name is required");
    const tags = parseTags(formData);
    // Atomic: contact + all its tag links in ONE transaction, tenant-stamped.
    const contact = await withTenantWrite(async (tx, tenantId) => {
      const c = await tx.contact.create({ data: { ...data, createdById: user.id, tenantId } });
      await syncContactTagsTx(tx, tenantId, c.id, tags);
      return c;
    });
    await logAudit({
      action: "contact.created",
      summary: `Created contact ${contactName(contact)}`,
      contactId: contact.id,
      user,
    });
    revalidatePath("/contacts");
    return { redirectTo: `/contacts/${contact.id}` };
  });
}

export async function updateContact(id: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requireContactAccess(id, "contacts.edit");
    const data = contactData(formData);
    if (!data.firstName) throw new ActionRefusal("Name is required");
    const tags = parseTags(formData);
    // Contact fields via the scoped client (RLS scopes the row to the tenant, and
    // matches legacy rows regardless of tenantId when enforcement is off). Tag
    // replacement is atomic: clear + re-add in ONE transaction, so a mid-way failure
    // can never leave the contact stripped of its tags.
    // READ FIRST, so the audit can say WHAT changed.
    //
    // Without a before/after pair `changedFields` diffs nothing against nothing
    // and stores an empty list, so the trail records only that "details were
    // updated" — no field, no old value, no new one. That is the entry someone
    // opens months later to find out who changed a phone number, and it could
    // not answer.
    const before = await prisma.contact.findUnique({ where: { id } });
    const contact = await prisma.contact.update({ where: { id }, data });
    await withTenantWrite(async (tx, tenantId) => {
      await tx.$executeRaw`DELETE FROM "_ContactToTag" WHERE "A" = ${id}`;
      await syncContactTagsTx(tx, tenantId, id, tags);
    });
    await logAudit({
      action: "contact.updated",
      summary: `Updated details for ${contactName(contact)}`,
      contactId: id,
      user,
      before,
      after: contact,
    });
    revalidatePath("/contacts");
    revalidatePath(`/contacts/${id}`);
    return { redirectTo: `/contacts/${id}` };
  });
}

export async function deleteContact(id: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requireContactAccess(id, "contacts.delete");
    const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
    const contact = await softDeleteRecord("contact", id, reason, user.name);
    // Nothing matched — another tenant's id, or already gone. Never audit a
    // deletion that did not happen.
    if (!contact) refuse("That contact could not be found.");
    await logAudit({
      action: "trash.deleted",
      summary: `Moved contact ${contactName(contact)} to trash — ${reason}`,
      contactId: id,
      user,
    });
    revalidatePath("/contacts");
    return { redirectTo: "/contacts" };
  });
}

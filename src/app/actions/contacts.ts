"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma, basePrisma } from "@/lib/db";
import { writeTenantId } from "@/lib/tenantWrite";
import { DEFAULT_TENANT_ID } from "@/lib/tenant";
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

async function upsertContactTag(name: string): Promise<string> {
  const tenantId = writeTenantId() ?? DEFAULT_TENANT_ID;
  const existing = await basePrisma.tag.findFirst({ where: { name, tenantId } });
  if (existing) return existing.id;
  const created = await basePrisma.tag.create({ data: { name, color: tagColor(name), tenantId } });
  return created.id;
}

async function syncContactTags(contactId: string, tagNames: string[]): Promise<void> {
  for (const name of tagNames) {
    const tagId = await upsertContactTag(name);
    await prisma.$executeRaw`INSERT INTO "_ContactToTag" ("A","B") VALUES (${contactId},${tagId}) ON CONFLICT DO NOTHING`;
  }
}

export async function createContact(formData: FormData) {
  const user = await requirePermission("contacts.create");
  const data = contactData(formData);
  if (!data.firstName) throw new Error("Name is required");
  const tags = parseTags(formData);
  const contact = await prisma.contact.create({
    data: { ...data, createdById: user.id },
  });
  await syncContactTags(contact.id, tags);
  await logAudit({
    action: "contact.created",
    summary: `Created contact ${contactName(contact)}`,
    contactId: contact.id,
    user,
  });
  revalidatePath("/contacts");
  redirect(`/contacts/${contact.id}`);
}

export async function updateContact(id: string, formData: FormData) {
  const user = await requireContactAccess(id, "contacts.edit");
  const data = contactData(formData);
  if (!data.firstName) throw new Error("Name is required");
  const tags = parseTags(formData);
  const contact = await prisma.contact.update({ where: { id }, data });
  await prisma.$executeRaw`DELETE FROM "_ContactToTag" WHERE "A" = ${id}`;
  await syncContactTags(id, tags);
  await logAudit({
    action: "contact.updated",
    summary: `Updated details for ${contactName(contact)}`,
    contactId: id,
    user,
  });
  revalidatePath("/contacts");
  revalidatePath(`/contacts/${id}`);
  redirect(`/contacts/${id}`);
}

export async function deleteContact(id: string, formData: FormData) {
  const user = await requireContactAccess(id, "contacts.delete");
  const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
  const contact = await softDeleteRecord("contact", id, reason, user.name);
  await logAudit({
    action: "trash.deleted",
    summary: `Moved contact ${contactName(contact)} to trash — ${reason}`,
    contactId: id,
    user,
  });
  revalidatePath("/contacts");
  redirect("/contacts");
}

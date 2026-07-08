"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireCrmOrWorkshop } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { softDeleteRecord } from "@/lib/trash";
import { contactName } from "@/lib/format";

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

export async function createContact(formData: FormData) {
  const user = await requireCrmOrWorkshop();
  const data = contactData(formData);
  if (!data.firstName) throw new Error("Name is required");
  const tags = parseTags(formData);
  const contact = await prisma.contact.create({
    data: {
      ...data,
      createdById: user.id,
      tags: {
        connectOrCreate: tags.map((name) => ({
          where: { name },
          create: { name, color: tagColor(name) },
        })),
      },
    },
  });
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
  const user = await requireCrmOrWorkshop();
  const data = contactData(formData);
  if (!data.firstName) throw new Error("Name is required");
  const tags = parseTags(formData);
  const contact = await prisma.contact.update({
    where: { id },
    data: {
      ...data,
      tags: {
        set: [],
        connectOrCreate: tags.map((name) => ({
          where: { name },
          create: { name, color: tagColor(name) },
        })),
      },
    },
  });
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
  const user = await requireCrmOrWorkshop();
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

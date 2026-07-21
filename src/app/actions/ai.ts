"use server";

import { prisma } from "@/lib/db";
import { requireOperational, requireOwner } from "@/lib/auth";
import { requireLeadAccess, requireContactAccess, canAccessContact } from "@/lib/permissions";
import { aiCheckDraft, aiResearch } from "@/lib/ai";
import { basePrisma } from "@/lib/db";
import { contactName } from "@/lib/format";

export type AiCheckState = { issues?: string[]; ok?: boolean; error?: string };

/** ✨ Check my message — proofreads a draft against the customer record. */
export async function checkDraft(
  _prev: AiCheckState | undefined,
  formData: FormData
): Promise<AiCheckState> {
  await requireOperational();
  const draft = String(formData.get("draft") ?? "").trim();
  if (!draft) return { error: "Nothing to check yet." };
  const contactId = String(formData.get("contactId") ?? "").trim();
  const leadId = String(formData.get("leadId") ?? "").trim();

  let customerName: string | null = null;
  if (contactId) {
    const c = await prisma.contact.findUnique({ where: { id: contactId } });
    if (c) customerName = contactName(c);
  } else if (leadId) {
    const l = await prisma.lead.findUnique({ where: { id: leadId } });
    if (l) customerName = l.name;
  }

  const result = await aiCheckDraft({ draft, customerName });
  if ("error" in result) return { error: result.error };
  return result.issues.length > 0 ? { issues: result.issues } : { ok: true };
}

/** Instant duplicate check while typing a new contact/lead. */
export async function findPossibleDuplicates(input: {
  name?: string;
  email?: string;
  phone?: string;
}): Promise<{ id: string; label: string; detail: string }[]> {
  await requireOperational();
  const email = (input.email ?? "").trim().toLowerCase();
  const digits = (input.phone ?? "").replace(/\D/g, "").slice(-9);
  const name = (input.name ?? "").trim();
  const nameParts = name.split(/\s+/).filter((p) => p.length > 2);

  if (!email && digits.length < 9 && nameParts.length === 0) return [];

  const matches = await prisma.contact.findMany({
    where: {
      OR: [
        ...(email ? [{ email: { equals: email, mode: "insensitive" as const } }] : []),
        ...(digits.length >= 9
          ? [{ phone: { contains: digits } }, { whatsapp: { contains: digits } }]
          : []),
        ...(nameParts.length > 0
          ? [
              {
                AND: nameParts.slice(0, 2).map((part) => ({
                  OR: [
                    { firstName: { contains: part, mode: "insensitive" as const } },
                    { lastName: { contains: part, mode: "insensitive" as const } },
                  ],
                })),
              },
            ]
          : []),
      ],
    },
    take: 3,
  });
  void basePrisma;
  return matches.map((c) => ({
    id: c.id,
    label: contactName(c),
    detail: [c.email, c.phone].filter(Boolean).join(" · ") || "no contact details",
  }));
}

/** Admin: wipe the system error log. */
export async function clearErrorLog() {
  await requireOwner();
  await basePrisma.errorLog.deleteMany({});
  // Without this the Settings → System tab keeps rendering the cached (now
  // deleted) rows, so the button looked like it did nothing.
  const { revalidatePath } = await import("next/cache");
  revalidatePath("/settings");
}

export type ResearchState = { summary?: string; error?: string };

/** 🔎 Research this lead/contact — company + person synopsis, stored on the record. */
export async function researchRecord(
  _prev: ResearchState | undefined,
  formData: FormData
): Promise<ResearchState> {
  await requireOperational();
  const leadId = String(formData.get("leadId") ?? "").trim() || null;
  const contactId = String(formData.get("contactId") ?? "").trim() || null;
  if (!leadId && !contactId) return { error: "Nothing to research." };

  // Authorize the record being enriched. The old code took the id straight from
  // the form and, after only a module gate, overwrote the research field of ANY
  // lead/contact by id and fired an outbound AI call on its name/email. Gate on
  // the record's own edit boundary (redirects a scoped user who can't touch it).
  const user = leadId
    ? await requireLeadAccess(leadId, "leads.edit")
    : await requireContactAccess(contactId!, "contacts.edit");

  let name = "";
  let email: string | null = null;
  let resolvedContactId = contactId;
  if (leadId) {
    const l = await prisma.lead.findUnique({ where: { id: leadId } });
    if (!l) return { error: "Lead not found." };
    name = l.name;
    email = l.email;
    // Link the research to the lead's contact too, so it shows on both.
    resolvedContactId = contactId ?? l.contactId;
  } else {
    const c = await prisma.contact.findUnique({ where: { id: contactId! } });
    if (!c) return { error: "Contact not found." };
    name = contactName(c);
    email = c.email;
  }

  // Only enrich the linked contact if this user may also access it — a lead-scoped
  // user must not write research onto a contact they can't otherwise see. (An
  // explicit contactId was already authorized above, so this is always true then.)
  const canWriteContact = resolvedContactId
    ? await canAccessContact(user, resolvedContactId)
    : false;

  const result = await aiResearch({ name, email });
  if ("error" in result) return { error: result.error };

  // Appended to the record's research history + latest snapshot column.
  const researchedAt = new Date();
  await prisma.researchNote.create({
    data: { body: result.summary, leadId, contactId: canWriteContact ? resolvedContactId : null },
  });
  if (leadId) {
    await prisma.lead.update({
      where: { id: leadId },
      data: { research: result.summary, researchedAt },
    });
  }
  if (resolvedContactId && canWriteContact) {
    await prisma.contact.update({
      where: { id: resolvedContactId },
      data: { research: result.summary, researchedAt },
    });
  }
  const { revalidatePath } = await import("next/cache");
  if (leadId) revalidatePath(`/leads/${leadId}`);
  if (resolvedContactId && canWriteContact) revalidatePath(`/contacts/${resolvedContactId}`);
  return { summary: result.summary };
}

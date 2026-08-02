"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { prisma, basePrisma } from "@/lib/db";
import { withEditableQuote } from "@/lib/quoteLock";
import { requireOwner } from "@/lib/auth";
import {
  requireContactAccess,
  requireLeadAccess,
  requireQuoteAccess,
  requireCaseAccess,
  type PermissionUser,
} from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import {
  isCustomEntity,
  isFieldType,
  slugifyKey,
  getFieldDefs,
  getFieldsWithValues,
  parseFieldValue,
  type CustomEntity,
  type FieldWithValue,
} from "@/lib/customFields";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** Create or update a custom-field definition. Owner only. */
export async function saveCustomFieldDef(formData: FormData) {
  const owner = await requireOwner();
  const id = str(formData, "id") || null;
  const entity = str(formData, "entity");
  const label = str(formData, "label");
  const type = str(formData, "type") || "text";
  if (!isCustomEntity(entity)) throw new Error("Unknown entity");
  if (!isFieldType(type)) throw new Error("Unknown field type");
  if (!label) throw new Error("Label is required");

  const options =
    type === "select"
      ? str(formData, "options")
          .split("\n")
          .map((o) => o.trim())
          .filter(Boolean)
      : [];
  const required = formData.get("required") === "on";
  const active = formData.get("active") !== "off"; // default on

  if (id) {
    await prisma.customFieldDef.update({
      where: { id },
      data: { label, type, options, required, active },
    });
  } else {
    // Machine key must be unique within the entity — suffix on collision.
    const existing = new Set((await getFieldDefs(entity, { includeInactive: true })).map((d) => d.key));
    const base = slugifyKey(label);
    let key = base;
    for (let i = 2; existing.has(key); i++) key = `${base}_${i}`;
    const max = await prisma.customFieldDef.aggregate({
      where: { entity },
      _max: { order: true },
    });
    await prisma.customFieldDef.create({
      data: {
        entity,
        key,
        label,
        type,
        options,
        required,
        active,
        order: (max._max.order ?? 0) + 1,
      },
    });
  }
  await logAudit({
    action: id ? "custom_field.updated" : "custom_field.created",
    summary: `${id ? "Updated" : "Added"} custom ${entity} field “${label}”`,
    user: owner,
  });
  revalidatePath("/settings/custom-fields");
  revalidatePath("/", "layout");
}

/** Delete a custom-field definition (and its values, via cascade). Owner only. */
export async function deleteCustomFieldDef(id: string) {
  const owner = await requireOwner();
  const def = await prisma.customFieldDef.findUnique({ where: { id } });
  if (!def) return;
  await prisma.customFieldDef.delete({ where: { id } });
  await logAudit({
    action: "custom_field.deleted",
    summary: `Deleted custom ${def.entity} field “${def.label}”`,
    user: owner,
  });
  revalidatePath("/settings/custom-fields");
  revalidatePath("/", "layout");
}

/** Guard editing a record's custom-field values with that entity's own edit boundary. */
async function requireEntityEdit(entity: CustomEntity, recordId: string): Promise<PermissionUser> {
  switch (entity) {
    case "contact": return requireContactAccess(recordId, "contacts.edit");
    case "lead": return requireLeadAccess(recordId, "leads.edit");
    case "quote": return requireQuoteAccess(recordId, "quotes.edit");
    case "case": return requireCaseAccess(recordId, "cases.manage");
  }
}

/**
 * Custom fields + current values for one record, for a client surface that
 * cannot read them itself — the quote editor dialog. Gated on the same access
 * as EDITING the record, because that is the only thing the caller can do with
 * them; a caller without it gets an empty list and no card.
 */
export async function recordCustomFields(
  entity: string,
  recordId: string,
): Promise<FieldWithValue[]> {
  if (!isCustomEntity(entity)) return [];
  try {
    await requireEntityEdit(entity, recordId);
  } catch {
    return [];
  }
  return getFieldsWithValues(entity, recordId);
}

/**
 * Save custom-field values for one record. Reads `cf_<defId>` inputs from the
 * form. Authorised with the same boundary as editing that record itself.
 *
 * Refusals travel as values. They used to be `throw new Error(...)`, which in
 * production reaches the browser as an opaque digest — so "Finance house is
 * required" arrived as `aBc123` and could only be shown as a generic apology.
 * It also hit the error boundary, which was survivable on a detail PAGE and is
 * not in the quote editor: a dialog replaced mid-edit takes the unsaved draft
 * with it.
 */
export async function saveCustomFieldValues(
  entity: string,
  recordId: string,
  formData: FormData,
): Promise<ActionResult> {
  return asActionResult(async () => saveCustomFieldValuesBody(entity, recordId, formData));
}

async function saveCustomFieldValuesBody(
  entity: string,
  recordId: string,
  formData: FormData,
) {
  if (!isCustomEntity(entity)) throw new Error("Unknown entity");
  await requireEntityEdit(entity, recordId);
  const defs = await getFieldDefs(entity);
  const basePath: Record<CustomEntity, string> = {
    contact: "/contacts",
    lead: "/leads",
    quote: "/quotes",
    case: "/cases",
  };

  // Parse+validate EVERY field first, collecting mutations and errors. Nothing
  // is written until all fields pass — otherwise an early field could persist
  // while a later required/invalid field throws, leaving a half-saved record.
  type Mutation = { defId: string; value: string | null };
  const mutations: Mutation[] = [];
  const errors: string[] = [];
  for (const def of defs) {
    const raw =
      def.type === "checkbox"
        ? formData.get(`cf_${def.id}`) === "on"
          ? "true"
          : "false"
        : str(formData, `cf_${def.id}`);
    const parsed = parseFieldValue(def, raw);
    if (!parsed.ok) {
      errors.push(parsed.error);
      continue;
    }
    mutations.push({ defId: def.id, value: parsed.value });
  }
  if (errors.length > 0) refuse(errors.join(" "));

  // Apply all upserts/deletes atomically. For a quote, hold the editability lock
  // FOR UPDATE across the writes and re-check editability inside it, so a
  // concurrent send/sign can't slip the quote out from under the customer (the
  // old preflight findUnique + separate upserts was a TOCTOU).
  const applyValues = async (tx: Prisma.TransactionClient) => {
    for (const m of mutations) {
      if (m.value === null) {
        await tx.customFieldValue.deleteMany({ where: { defId: m.defId, recordId } });
      } else {
        await tx.customFieldValue.upsert({
          where: { defId_recordId: { defId: m.defId, recordId } },
          update: { value: m.value },
          create: { defId: m.defId, recordId, value: m.value },
        });
      }
    }
  };
  if (entity === "quote") {
    const outcome = await withEditableQuote(recordId, applyValues);
    if (!outcome.ok) refuse("This quote is locked and can no longer be edited.");
  } else {
    await basePrisma.$transaction(applyValues);
  }
  revalidatePath(`${basePath[entity]}/${recordId}`);
}

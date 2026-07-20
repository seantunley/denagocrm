"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
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
  type CustomEntity,
} from "@/lib/customFields";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** Create or update a custom-field definition. Owner only. */
export async function saveCustomFieldDef(formData: FormData) {
  await requireOwner();
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
    userName: "Owner",
  });
  revalidatePath("/settings/custom-fields");
  revalidatePath("/", "layout");
}

/** Delete a custom-field definition (and its values, via cascade). Owner only. */
export async function deleteCustomFieldDef(id: string) {
  await requireOwner();
  const def = await prisma.customFieldDef.findUnique({ where: { id } });
  if (!def) return;
  await prisma.customFieldDef.delete({ where: { id } });
  await logAudit({
    action: "custom_field.deleted",
    summary: `Deleted custom ${def.entity} field “${def.label}”`,
    userName: "Owner",
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
 * Save custom-field values for one record. Reads `cf_<defId>` inputs from the
 * form. Authorised with the same boundary as editing that record itself.
 */
export async function saveCustomFieldValues(
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

  for (const def of defs) {
    const raw =
      def.type === "checkbox"
        ? formData.get(`cf_${def.id}`) === "on"
          ? "true"
          : "false"
        : str(formData, `cf_${def.id}`);
    const empty = def.type === "checkbox" ? false : raw === "";
    if (def.required && empty) throw new Error(`${def.label} is required`);

    if (empty) {
      await prisma.customFieldValue.deleteMany({ where: { defId: def.id, recordId } });
    } else {
      await prisma.customFieldValue.upsert({
        where: { defId_recordId: { defId: def.id, recordId } },
        update: { value: raw },
        create: { defId: def.id, recordId, value: raw },
      });
    }
  }
  revalidatePath(`${basePath[entity]}/${recordId}`);
}

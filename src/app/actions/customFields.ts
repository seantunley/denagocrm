"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { prisma, basePrisma } from "@/lib/db";
import { withEditableQuote } from "@/lib/quoteLock";
import { requireTenantOwner } from "@/lib/auth";
import {
  requireContactAccess,
  requireLeadAccess,
  requireQuoteAccess,
  requireCaseAccess,
  requireVehicleAccess,
  requireJobCardAccess,
  requirePermission,
  type PermissionUser,
} from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { withActingStaffScope } from "@/lib/actingScope";
import { actingTenantId } from "@/lib/actingTenant";
import {
  isCustomEntity,
  isFieldType,
  isFieldShown,
  isLinkTarget,
  linkTargetExists,
  parseShowWhen,
  slugifyKey,
  getFieldDefs,
  getFieldsWithValues,
  loadLinkChoices,
  parseFieldValue,
  type CustomEntity,
  type FieldWithValue,
  type LinkChoices,
} from "@/lib/customFields";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/*
 * EVERY read and write below names the acting workspace (review of #1064). With
 * enforcement dormant the Prisma client is not scoped, so an unnamed query reads
 * — and a by-id write reaches — every workspace's rows.
 */

/** Create or update a custom-field definition. Owner only, this workspace only. */
export async function saveCustomFieldDef(formData: FormData) {
  return asActionResult(async () => {
    const owner = await requireTenantOwner();
    const tenantId = await actingTenantId();
    const id = str(formData, "id") || null;
    const entity = str(formData, "entity");
    const label = str(formData, "label");
    const type = str(formData, "type") || "text";
    if (!isCustomEntity(entity)) refuse("Choose what the field belongs to.");
    if (!isFieldType(type)) refuse("Choose a field type.");
    if (!label) refuse("Give the field a label.");

    const options =
      type === "select" || type === "multiselect"
        ? [...new Set(str(formData, "options")
            .split("\n")
            .map((o) => o.trim())
            .filter(Boolean))]
        : [];
    if ((type === "select" || type === "multiselect") && options.length === 0) {
      refuse("Add at least one option, one per line.");
    }
    const linkTo = type === "link" ? str(formData, "linkTo") : null;
    if (type === "link" && !isLinkTarget(linkTo)) refuse("Choose what the field links to.");
    const required = formData.get("required") === "on";
    const active = formData.get("active") !== "off"; // default on

    // "Show only when…" — another field of the SAME record type, never this one.
    const whenKey = str(formData, "showWhenKey");
    let showWhen: Prisma.InputJsonValue | typeof Prisma.DbNull = Prisma.DbNull;
    if (whenKey) {
      const siblings = await getFieldDefs(entity, { tenantId, includeInactive: true });
      const control = siblings.find((d) => d.key === whenKey);
      if (!control || control.id === id) refuse("“Show only when” must name another field on the same record.");
      const rule = parseShowWhen({ key: whenKey, op: str(formData, "showWhenOp"), value: str(formData, "showWhenValue") });
      if (!rule) refuse("Choose how “Show only when” compares.");
      if (rule.op !== "filled" && control.type !== "checkbox" && !rule.value) refuse("Say which answer shows this field.");
      showWhen = rule;
    }

    if (id) {
      // Only this workspace's field: a by-id update would otherwise reach another's.
      const updated = await prisma.customFieldDef.updateMany({
        where: { id, tenantId },
        data: { label, type, options, required, active, showWhen, linkTo },
      });
      if (updated.count !== 1) refuse("That field is not in this workspace — refresh the page.");
    } else {
      // Machine key must be unique within the entity — suffix on collision.
      const existing = new Set((await getFieldDefs(entity, { tenantId, includeInactive: true })).map((d) => d.key));
      const base = slugifyKey(label);
      let key = base;
      for (let i = 2; existing.has(key); i++) key = `${base}_${i}`;
      const max = await prisma.customFieldDef.aggregate({
        where: { entity, tenantId },
        _max: { order: true },
      });
      await prisma.customFieldDef.create({
        data: {
          tenantId,
          entity,
          key,
          label,
          type,
          options,
          required,
          active,
          showWhen,
          linkTo,
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
    return { success: id ? "Field updated" : "Field added" };
  });
}

/** Delete a custom-field definition (and its values, via cascade). Owner only. */
export async function deleteCustomFieldDef(id: string) {
  return asActionResult(async () => {
    const owner = await requireTenantOwner();
    const tenantId = await actingTenantId();
    const def = await prisma.customFieldDef.findFirst({ where: { id, tenantId } });
    if (!def) refuse("That field is already gone — refresh the page.");
    await prisma.customFieldDef.deleteMany({ where: { id, tenantId } });
    await logAudit({
      action: "custom_field.deleted",
      summary: `Deleted custom ${def.entity} field “${def.label}”`,
      user: owner,
    });
    revalidatePath("/settings/custom-fields");
    revalidatePath("/", "layout");
  });
}

/**
 * Guard editing a record's custom-field values with that entity's own edit
 * boundary — and, for every record type, that the record is in `tenantId`.
 */
async function requireEntityEdit(entity: CustomEntity, recordId: string, tenantId: string): Promise<PermissionUser> {
  switch (entity) {
    case "contact": return requireContactAccess(recordId, "contacts.edit");
    case "lead": return requireLeadAccess(recordId, "leads.edit");
    case "quote": return requireQuoteAccess(recordId, "quotes.edit");
    case "case": return requireCaseAccess(recordId, "cases.manage");
    case "vehicle": return requireVehicleAccess(recordId, "vehicles.manage");
    case "jobcard": return requireJobCardAccess(recordId, "jobcards.manage");
    // Same doors as editing the row itself (updateProduct / updateStockUnit), plus
    // the row must be in this workspace — a role check alone is not row ownership.
    // The row's workspace is checked explicitly (review of #1064), not left to the client's scope.
    case "product": {
      const user = await requireTenantOwner();
      if ((await prisma.product.count({ where: { id: recordId, tenantId, deletedAt: null } })) !== 1) refuse("That product is not in this workspace.");
      return user;
    }
    case "stock": {
      const user = await requirePermission("stock.manage");
      if ((await prisma.stockUnit.count({ where: { id: recordId, tenantId, deletedAt: null } })) !== 1) refuse("That stock unit is not in this workspace.");
      return user;
    }
  }
}

/** Where each record type's detail page lives, for revalidation after a save. */
const DETAIL_PATH: Record<CustomEntity, string> = {
  contact: "/contacts",
  lead: "/leads",
  quote: "/quotes",
  case: "/cases",
  vehicle: "/vehicles",
  jobcard: "/jobcards",
  product: "/products",
  stock: "/stock",
};

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
  return withActingStaffScope(async () => {
    if (!isCustomEntity(entity)) return [];
    const tenantId = await actingTenantId();
    try {
      await requireEntityEdit(entity, recordId, tenantId);
    } catch {
      return [];
    }
    return getFieldsWithValues(entity, recordId, tenantId);
  });
}

/**
 * What the link fields on one record's form may point at — for the quote editor
 * dialog, which cannot load them server-side. Same gate as recordCustomFields.
 */
export async function recordLinkChoices(entity: string, recordId: string): Promise<LinkChoices> {
  return withActingStaffScope(async () => {
    if (!isCustomEntity(entity)) return {};
    const tenantId = await actingTenantId();
    try {
      await requireEntityEdit(entity, recordId, tenantId);
    } catch {
      return {};
    }
    return loadLinkChoices(await getFieldsWithValues(entity, recordId, tenantId), tenantId);
  });
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
  return asActionResult(async () => withActingStaffScope(() => saveCustomFieldValuesBody(entity, recordId, formData)));
}

async function saveCustomFieldValuesBody(
  entity: string,
  recordId: string,
  formData: FormData,
) {
  if (!isCustomEntity(entity)) throw new Error("Unknown entity");
  const tenantId = await actingTenantId();
  await requireEntityEdit(entity, recordId, tenantId);
  const defs = await getFieldDefs(entity, { tenantId });

  const rawOf = (def: (typeof defs)[number]) =>
    def.type === "checkbox"
      ? formData.get(`cf_${def.id}`) === "on"
        ? "true"
        : "false"
      : def.type === "multiselect"
        ? JSON.stringify(formData.getAll(`cf_${def.id}`).map(String))
        : str(formData, `cf_${def.id}`);
  const submitted = new Map(defs.map((def) => [def.key, rawOf(def)]));
  const defsByKey = new Map(defs.map((def) => [def.key, def]));

  // Parse+validate EVERY field first, collecting mutations and errors. Nothing
  // is written until all fields pass — otherwise an early field could persist
  // while a later required/invalid field throws, leaving a half-saved record.
  type Mutation = { defId: string; value: string | null };
  const mutations: Mutation[] = [];
  const errors: string[] = [];
  for (const def of defs) {
    // A field hidden by "Show only when…" is not on the form: it is neither
    // required nor overwritten, so flipping the answer back brings its value back.
    if (!isFieldShown(def, defsByKey, submitted)) continue;
    const parsed = parseFieldValue(def, submitted.get(def.key) ?? "");
    if (!parsed.ok) {
      errors.push(parsed.error);
      continue;
    }
    if (parsed.value && def.type === "link" && (!def.linkTo || !(await linkTargetExists(def.linkTo, parsed.value, tenantId)))) {
      errors.push(`${def.label} points at a record that isn't in this workspace.`);
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
      // The def ids came from THIS workspace's definitions; the rows are stamped with it too.
      if (m.value === null) {
        await tx.customFieldValue.deleteMany({ where: { defId: m.defId, recordId, tenantId } });
      } else {
        await tx.customFieldValue.upsert({
          where: { defId_recordId: { defId: m.defId, recordId } },
          update: { value: m.value },
          create: { tenantId, defId: m.defId, recordId, value: m.value },
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
  revalidatePath(`${DETAIL_PATH[entity]}/${recordId}`);
}

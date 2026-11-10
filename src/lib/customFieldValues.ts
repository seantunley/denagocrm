import { prisma } from "./db";
import {
  normalizeDef,
  parseFieldValue,
  ruleValue,
  type CustomEntity,
  type DefRow,
  type FieldDef,
  type FieldWithValue,
  type LinkTarget,
} from "./customFields-helpers";

// The custom-field READS and the one by-key WRITE, with no `server-only` marker:
// the journey engine and stage-gate facts import these, and their unit tests load
// those modules in plain node. Anything that knows the signed-in user
// (loadLinkChoices) stays in customFields.ts, which re-exports all of this.

/** Definitions for an entity, ordered. Active-only unless includeInactive. */
export async function getFieldDefs(
  entity: CustomEntity,
  /** `tenantId`: name the workspace explicitly — the journey engine and other system-scoped callers must. */
  opts: { includeInactive?: boolean; tenantId?: string } = {},
): Promise<FieldDef[]> {
  const rows = await prisma.customFieldDef.findMany({
    where: {
      entity,
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
      ...(opts.includeInactive ? {} : { active: true }),
    },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
  });
  return rows.map((r) => normalizeDef(r as DefRow));
}

/** Active definitions for an entity paired with a record's current values. */
export async function getFieldsWithValues(
  entity: CustomEntity,
  recordId: string,
  tenantId?: string,
): Promise<FieldWithValue[]> {
  const defs = await getFieldDefs(entity, { tenantId });
  if (defs.length === 0) return [];
  const values = await prisma.customFieldValue.findMany({
    where: { recordId, defId: { in: defs.map((d) => d.id) }, ...(tenantId ? { tenantId } : {}) },
  });
  const byDef = new Map(values.map((v) => [v.defId, v.value]));
  return defs.map((def) => ({ def, value: byDef.get(def.id) ?? null }));
}

/**
 * One record's custom values keyed by field key, typed for the rule engines
 * (stage rules read `custom.<key>`, journeys `lead.custom.<key>` /
 * `contact.custom.<key>`). Active fields only, every one present — an unset
 * field reads as empty, so "is empty" works on it.
 */
export async function customRuleValues(
  entity: CustomEntity,
  recordId: string,
  tenantId?: string,
): Promise<Record<string, ReturnType<typeof ruleValue>>> {
  const fields = await getFieldsWithValues(entity, recordId, tenantId);
  return Object.fromEntries(fields.map(({ def, value }) => [def.key, ruleValue(def, value)]));
}

/** Does a link field's target record exist in this workspace (and isn't deleted)? */
export async function linkTargetExists(target: LinkTarget, id: string, tenantId?: string): Promise<boolean> {
  const t = tenantId ? { tenantId } : {};
  switch (target) {
    case "contact":
      return (await prisma.contact.count({ where: { id, deletedAt: null, ...t } })) === 1;
    case "lead":
      return (await prisma.lead.count({ where: { id, deletedAt: null, ...t } })) === 1;
    case "vehicle":
      return (await prisma.vehicle.count({ where: { id, deletedAt: null, ...t } })) === 1;
    case "product":
      return (await prisma.product.count({ where: { id, deletedAt: null, ...t } })) === 1;
  }
}

/**
 * Set ONE custom field on a record by its key — the journey "Set a field" step.
 * Validated exactly like the form (same parser, same link check), so a journey
 * cannot store a value a person could not have typed. The workspace is named
 * explicitly on every read and write: the journey runner may be system-scoped.
 */
export async function setCustomFieldByKey(
  entity: CustomEntity,
  recordId: string,
  key: string,
  raw: string,
  tenantId: string,
): Promise<{ ok: true; label: string; cleared: boolean } | { ok: false; error: string }> {
  const def = (await getFieldDefs(entity, { tenantId })).find((d) => d.key === key);
  if (!def) return { ok: false, error: `no active field “${key}”` };
  const parsed = parseFieldValue(def, raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (parsed.value && def.type === "link" && (!def.linkTo || !(await linkTargetExists(def.linkTo, parsed.value, tenantId)))) {
    return { ok: false, error: `${def.label} points at a record that isn't in this workspace` };
  }
  if (parsed.value === null) {
    await prisma.customFieldValue.deleteMany({ where: { defId: def.id, recordId, tenantId } });
  } else {
    await prisma.customFieldValue.upsert({
      where: { defId_recordId: { defId: def.id, recordId } },
      update: { value: parsed.value },
      create: { tenantId, defId: def.id, recordId, value: parsed.value },
    });
  }
  return { ok: true, label: def.label, cleared: parsed.value === null };
}

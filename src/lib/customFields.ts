import "server-only";
import { prisma } from "@/lib/db";
import {
  normalizeDef,
  type CustomEntity,
  type FieldDef,
  type FieldWithValue,
  type DefRow,
} from "./customFields-helpers";

// ─── Custom fields (Path A, Phase 2) ─────────────────────────────────
// A workspace can add its own fields to core objects so the CRM fits a
// business the built-in schema didn't anticipate. Definitions live per entity;
// values are stored as text and coerced by the field's type on read.
//
// Types, constants and pure helpers live in `customFields-helpers.ts` (no
// server-only / Prisma deps, so they're unit-testable) and are re-exported here
// so `@/lib/customFields` stays the single import point for consumers.

export * from "./customFields-helpers";

/** Definitions for an entity, ordered. Active-only unless includeInactive. */
export async function getFieldDefs(
  entity: CustomEntity,
  opts: { includeInactive?: boolean } = {},
): Promise<FieldDef[]> {
  const rows = await prisma.customFieldDef.findMany({
    where: { entity, ...(opts.includeInactive ? {} : { active: true }) },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
  });
  return rows.map((r) => normalizeDef(r as DefRow));
}

/** Active definitions for an entity paired with a record's current values. */
export async function getFieldsWithValues(
  entity: CustomEntity,
  recordId: string,
): Promise<FieldWithValue[]> {
  const defs = await getFieldDefs(entity);
  if (defs.length === 0) return [];
  const values = await prisma.customFieldValue.findMany({
    where: { recordId, defId: { in: defs.map((d) => d.id) } },
  });
  const byDef = new Map(values.map((v) => [v.defId, v.value]));
  return defs.map((def) => ({ def, value: byDef.get(def.id) ?? null }));
}

/** Does an entity have any active custom fields? Cheap gate for detail views. */
export async function hasCustomFields(entity: CustomEntity): Promise<boolean> {
  const n = await prisma.customFieldDef.count({ where: { entity, active: true } });
  return n > 0;
}

/** A custom value paired with its (normalised) definition, for a known record. */
export type CollectedCustomValue = {
  recordId: string;
  def: FieldDef;
  value: string | null;
};

/**
 * Every custom value stored for a set of records of one entity, each paired
 * with its definition (label/type/options). Used by export and display paths
 * where a record's custom fields must travel with its built-in columns.
 * Includes inactive defs — the data is still the record's, and a POPIA export
 * must not drop it just because the field was later switched off.
 */
export async function collectCustomValues(
  entity: CustomEntity,
  recordIds: string[],
): Promise<CollectedCustomValue[]> {
  if (recordIds.length === 0) return [];
  const rows = await prisma.customFieldValue.findMany({
    where: { recordId: { in: recordIds }, def: { entity } },
    include: { def: true },
  });
  return rows.map((r) => ({
    recordId: r.recordId,
    def: normalizeDef(r.def as DefRow),
    value: r.value,
  }));
}

/**
 * Hard-delete every custom value for a set of records of one entity. Custom
 * values key on `recordId` with NO foreign key, so nothing cascades when the
 * owning contact/lead/quote/case row is anonymised or permanently purged —
 * callers must invoke this to avoid orphaned PII.
 */
export async function deleteCustomValuesFor(
  entity: CustomEntity,
  recordIds: string[],
): Promise<number> {
  if (recordIds.length === 0) return 0;
  const res = await prisma.customFieldValue.deleteMany({
    where: { recordId: { in: recordIds }, def: { entity } },
  });
  return res.count;
}

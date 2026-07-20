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

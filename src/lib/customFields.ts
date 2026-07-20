import "server-only";
import { prisma } from "@/lib/db";

// ─── Custom fields (Path A, Phase 2) ─────────────────────────────────
// A workspace can add its own fields to core objects so the CRM fits a
// business the built-in schema didn't anticipate. Definitions live per entity;
// values are stored as text and coerced by the field's type on read.

export type CustomEntity = "contact" | "lead" | "quote" | "case";

export const CUSTOM_ENTITIES: { id: CustomEntity; label: string }[] = [
  { id: "contact", label: "Contacts" },
  { id: "lead", label: "Leads" },
  { id: "quote", label: "Quotes" },
  { id: "case", label: "Help desk cases" },
];

export const CUSTOM_ENTITY_IDS = CUSTOM_ENTITIES.map((e) => e.id);

export function isCustomEntity(value: string): value is CustomEntity {
  return (CUSTOM_ENTITY_IDS as string[]).includes(value);
}

export const FIELD_TYPES = [
  { id: "text", label: "Text" },
  { id: "textarea", label: "Paragraph" },
  { id: "number", label: "Number" },
  { id: "date", label: "Date" },
  { id: "select", label: "Dropdown" },
  { id: "checkbox", label: "Checkbox (yes / no)" },
  { id: "url", label: "Link (URL)" },
] as const;

export type FieldType = (typeof FIELD_TYPES)[number]["id"];
const FIELD_TYPE_IDS = FIELD_TYPES.map((t) => t.id) as string[];
export function isFieldType(value: string): value is FieldType {
  return FIELD_TYPE_IDS.includes(value);
}

export type FieldDef = {
  id: string;
  entity: CustomEntity;
  key: string;
  label: string;
  type: FieldType;
  options: string[];
  required: boolean;
  order: number;
  active: boolean;
};

export type FieldWithValue = { def: FieldDef; value: string | null };

type DefRow = {
  id: string;
  entity: string;
  key: string;
  label: string;
  type: string;
  options: unknown;
  required: boolean;
  order: number;
  active: boolean;
};

function normalizeDef(row: DefRow): FieldDef {
  const options = Array.isArray(row.options)
    ? (row.options as unknown[]).map((o) => String(o))
    : [];
  return {
    id: row.id,
    entity: (isCustomEntity(row.entity) ? row.entity : "contact"),
    key: row.key,
    label: row.label,
    type: (isFieldType(row.type) ? row.type : "text"),
    options,
    required: row.required,
    order: row.order,
    active: row.active,
  };
}

/** Turn a human label into a stable machine key unique within an entity. */
export function slugifyKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50) || "field";
}

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

/** Human-readable rendering of a stored value for a field type. */
export function displayValue(def: FieldDef, value: string | null): string {
  if (value == null || value === "") return "—";
  if (def.type === "checkbox") return value === "true" ? "Yes" : "No";
  return value;
}

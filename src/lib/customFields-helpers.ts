// ─── Custom fields (Path A, Phase 2) — pure helpers ──────────────────
// Types, constants and pure functions with no server-only / Prisma deps, so
// they can be unit-tested in a plain node process. The data-access layer in
// `customFields.ts` re-exports everything here alongside its DB reads.

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

export type DefRow = {
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

export function normalizeDef(row: DefRow): FieldDef {
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

/** Human-readable rendering of a stored value for a field type. */
export function displayValue(def: FieldDef, value: string | null): string {
  if (value == null || value === "") return "—";
  if (def.type === "checkbox") return value === "true" ? "Yes" : "No";
  return value;
}

/**
 * Result of parsing+validating one raw form value against its definition.
 * `ok:true` with `value:null` means "clear the stored value" (delete the row);
 * a string means "store this value". `ok:false` carries a user-facing message.
 */
export type FieldParseResult =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

/**
 * Pure parse+validate for a single custom-field input. No DB, no I/O — so the
 * save action can validate EVERY field before writing anything, and so the
 * rules are unit-testable.
 *
 * Rules by type:
 *  - checkbox  → always "true"/"false" (never empty, never required-blocked)
 *  - required  → non-checkbox empty value is an error
 *  - number    → must parse to a finite Number
 *  - date      → must be a parseable date (ISO or Date.parse-able)
 *  - url       → must be a valid http:/https: URL
 *  - select    → value must be one of the definition's options
 *  - text/textarea → passed through trimmed
 */
export function parseFieldValue(def: FieldDef, raw: string): FieldParseResult {
  if (def.type === "checkbox") {
    return { ok: true, value: raw === "true" || raw === "on" ? "true" : "false" };
  }

  const trimmed = raw.trim();
  if (trimmed === "") {
    if (def.required) return { ok: false, error: `${def.label} is required` };
    return { ok: true, value: null };
  }

  switch (def.type) {
    case "number": {
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return { ok: false, error: `${def.label} must be a number` };
      return { ok: true, value: trimmed };
    }
    case "date": {
      if (Number.isNaN(Date.parse(trimmed))) {
        return { ok: false, error: `${def.label} must be a valid date` };
      }
      return { ok: true, value: trimmed };
    }
    case "url": {
      let url: URL;
      try {
        url = new URL(trimmed);
      } catch {
        return { ok: false, error: `${def.label} must be a valid link (URL)` };
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { ok: false, error: `${def.label} must be an http or https link` };
      }
      return { ok: true, value: trimmed };
    }
    case "select": {
      if (!def.options.includes(trimmed)) {
        return { ok: false, error: `${def.label} must be one of the allowed options` };
      }
      return { ok: true, value: trimmed };
    }
    default:
      return { ok: true, value: trimmed };
  }
}

// ─── Custom fields (Path A, Phase 2) — pure helpers ──────────────────
// Types, constants and pure functions with no server-only / Prisma deps, so
// they can be unit-tested in a plain node process. The data-access layer in
// `customFields.ts` re-exports everything here alongside its DB reads.

export type CustomEntity =
  | "contact"
  | "lead"
  | "quote"
  | "case"
  | "vehicle"
  | "jobcard"
  | "product"
  | "stock";

export const CUSTOM_ENTITIES: { id: CustomEntity; label: string }[] = [
  { id: "contact", label: "Contacts" },
  { id: "lead", label: "Leads" },
  { id: "quote", label: "Quotes" },
  { id: "case", label: "Help desk cases" },
  { id: "vehicle", label: "Vehicles" },
  { id: "jobcard", label: "Job cards" },
  { id: "product", label: "Products" },
  { id: "stock", label: "Stock units" },
];

export const CUSTOM_ENTITY_IDS = CUSTOM_ENTITIES.map((e) => e.id);

export function isCustomEntity(value: string): value is CustomEntity {
  return (CUSTOM_ENTITY_IDS as string[]).includes(value);
}

export const FIELD_TYPES = [
  { id: "text", label: "Text" },
  { id: "textarea", label: "Paragraph" },
  { id: "number", label: "Number" },
  { id: "currency", label: "Money" },
  { id: "date", label: "Date" },
  { id: "select", label: "Dropdown" },
  { id: "multiselect", label: "Tick several" },
  { id: "checkbox", label: "Checkbox (yes / no)" },
  { id: "url", label: "Web address (URL)" },
  { id: "link", label: "Link to a record" },
] as const;

export type FieldType = (typeof FIELD_TYPES)[number]["id"];
const FIELD_TYPE_IDS = FIELD_TYPES.map((t) => t.id) as string[];
export function isFieldType(value: string): value is FieldType {
  return FIELD_TYPE_IDS.includes(value);
}

/** What a "Link to a record" field can point at. */
export const LINK_TARGETS = [
  { id: "contact", label: "Contact" },
  { id: "lead", label: "Lead" },
  { id: "vehicle", label: "Vehicle" },
  { id: "product", label: "Product" },
] as const;
export type LinkTarget = (typeof LINK_TARGETS)[number]["id"];
export function isLinkTarget(value: unknown): value is LinkTarget {
  return LINK_TARGETS.some((t) => t.id === value);
}

/**
 * "Show only when…" — a field that only matters once another field has a given
 * answer (e.g. "Finance house" only when "Paying by" is Finance).
 * `filled` = the other field has any value (a checkbox: ticked).
 */
export const SHOW_WHEN_OPS = [
  { id: "equals", label: "is" },
  { id: "not_equals", label: "is not" },
  { id: "filled", label: "has a value" },
] as const;
export type ShowWhenOp = (typeof SHOW_WHEN_OPS)[number]["id"];
export type ShowWhen = { key: string; op: ShowWhenOp; value?: string };

export function parseShowWhen(raw: unknown): ShowWhen | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const key = typeof r.key === "string" ? r.key.trim() : "";
  const op = SHOW_WHEN_OPS.find((o) => o.id === r.op)?.id;
  if (!key || !op) return null;
  if (op === "filled") return { key, op };
  return { key, op, value: typeof r.value === "string" ? r.value : String(r.value ?? "") };
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
  showWhen: ShowWhen | null;
  linkTo: LinkTarget | null;
};

export type FieldWithValue = { def: FieldDef; value: string | null };

/** A record a link field can point at, as the picker and the read-only view show it. */
export type LinkChoice = { id: string; label: string };
/** Choices per link target, loaded server-side for the records this viewer may see. */
export type LinkChoices = Partial<Record<LinkTarget, LinkChoice[]>>;

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
  showWhen?: unknown;
  linkTo?: string | null;
};

export function normalizeDef(row: DefRow): FieldDef {
  const options = Array.isArray(row.options)
    ? (row.options as unknown[]).map((o) => String(o))
    : [];
  const type = isFieldType(row.type) ? row.type : "text";
  return {
    id: row.id,
    entity: (isCustomEntity(row.entity) ? row.entity : "contact"),
    key: row.key,
    label: row.label,
    type,
    options,
    required: row.required,
    order: row.order,
    active: row.active,
    showWhen: parseShowWhen(row.showWhen),
    linkTo: type === "link" && isLinkTarget(row.linkTo) ? row.linkTo : null,
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

/** A stored multi-select value as its list of picked options. Tolerates junk. */
export function multiValues(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Human-readable rendering of a stored value for a field type. */
export function displayValue(def: FieldDef, value: string | null, links?: LinkChoices): string {
  if (value == null || value === "") return "—";
  if (def.type === "checkbox") return value === "true" ? "Yes" : "No";
  if (def.type === "multiselect") return multiValues(value).join(", ") || "—";
  if (def.type === "currency") {
    const n = Number(value);
    return Number.isFinite(n)
      ? n.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : value;
  }
  if (def.type === "link") {
    const hit = def.linkTo ? links?.[def.linkTo]?.find((c) => c.id === value) : undefined;
    return hit?.label ?? "A record you can't open";
  }
  return value;
}

/**
 * Should this field show, given the record's other answers?
 *
 * `values` is keyed by field KEY (what showWhen names). A field whose controller
 * is missing or inactive shows — hiding a field because its rule points at
 * nothing would make data unreachable. A controller that is itself hidden hides
 * this one too, and a loop (A shows when B, B shows when A) shows both.
 */
export function isFieldShown(
  def: FieldDef,
  defsByKey: ReadonlyMap<string, FieldDef>,
  values: ReadonlyMap<string, string | null>,
  seen: Set<string> = new Set(),
): boolean {
  const rule = def.showWhen;
  if (!rule) return true;
  const control = defsByKey.get(rule.key);
  if (!control || seen.has(def.key)) return true;
  seen.add(def.key);
  if (!isFieldShown(control, defsByKey, values, seen)) return false;

  const raw = values.get(rule.key) ?? null;
  const picked =
    control.type === "multiselect"
      ? multiValues(raw)
      : control.type === "checkbox"
        ? raw === "true" ? ["true"] : []
        : raw && raw.trim() ? [raw.trim()] : [];
  if (rule.op === "filled") return picked.length > 0;
  const expected = control.type === "checkbox" ? (rule.value === "true" ? "true" : "false") : (rule.value ?? "");
  const matches =
    control.type === "checkbox"
      ? (picked.length > 0 ? "true" : "false") === expected
      : picked.includes(expected);
  return rule.op === "equals" ? matches : !matches;
}

/**
 * A stored value in the shape the rule engines compare on (stage rules and
 * journey conditions): numbers as numbers, a multi-select as a list (so
 * "contains" means "has this ticked"), everything else as stored text.
 */
export function ruleValue(def: FieldDef, value: string | null): string | number | string[] | null {
  if (value == null || value === "") return def.type === "multiselect" ? [] : def.type === "checkbox" ? "false" : null;
  if (def.type === "number" || def.type === "currency") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (def.type === "multiselect") return multiValues(value);
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

/** A record id as the app generates them (cuid). Anything else is not a link. */
const RECORD_ID = /^[a-z0-9]{8,40}$/i;

/**
 * Pure parse+validate for a single custom-field input. No DB, no I/O — so the
 * save action can validate EVERY field before writing anything, and so the
 * rules are unit-testable.
 *
 * Rules by type:
 *  - checkbox    → always "true"/"false" (never empty, never required-blocked)
 *  - required    → non-checkbox empty value is an error
 *  - number      → must parse to a finite Number
 *  - currency    → a finite amount ("R 1 250,50" is fine), stored with 2 decimals
 *  - date        → must be a parseable date (ISO or Date.parse-able)
 *  - url         → must be a valid http:/https: URL
 *  - select      → value must be one of the definition's options
 *  - multiselect → raw is a JSON list; every item one of the options; stored in option order
 *  - link        → a record id (the action checks the record exists in this workspace)
 *  - text/textarea → passed through trimmed
 */
export function parseFieldValue(def: FieldDef, raw: string): FieldParseResult {
  if (def.type === "checkbox") {
    return { ok: true, value: raw === "true" || raw === "on" ? "true" : "false" };
  }

  if (def.type === "multiselect") {
    const picked = raw.trim() ? multiValues(raw.trim()) : [];
    if (picked.length === 0) {
      if (def.required) return { ok: false, error: `${def.label} is required` };
      return { ok: true, value: null };
    }
    if (picked.some((p) => !def.options.includes(p))) {
      return { ok: false, error: `${def.label} must only use the allowed options` };
    }
    return { ok: true, value: JSON.stringify(def.options.filter((o) => picked.includes(o))) };
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
    case "currency": {
      const cleaned = trimmed.replace(/^[A-Za-z]{1,3}\s*|[\s ]/g, "");
      const normalised = cleaned.includes(",") && !cleaned.includes(".") ? cleaned.replace(",", ".") : cleaned.replace(/,/g, "");
      const n = Number(normalised);
      if (!Number.isFinite(n)) return { ok: false, error: `${def.label} must be an amount` };
      return { ok: true, value: n.toFixed(2) };
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
    case "link": {
      if (!RECORD_ID.test(trimmed)) return { ok: false, error: `${def.label} must be a record from the list` };
      return { ok: true, value: trimmed };
    }
    default:
      return { ok: true, value: trimmed };
  }
}

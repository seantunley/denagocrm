/**
 * What a user-built card is allowed to ask about — the ALLOWLIST.
 *
 * This is the security boundary for the card builder, and it is worth being
 * precise about why it takes this shape rather than the obvious one.
 *
 * The obvious design for "let people build their own cards" is to let the config
 * name a Prisma model and a `where` object and pass them through. That is a
 * remote query engine. A saved config is user input that outlives the session
 * that wrote it, so it would let anyone who can save a dashboard read any column
 * of any table the app's database user can reach — including password hashes,
 * signing tokens and other tenants' rows if enforcement is ever off. No amount
 * of validating the SHAPE of that object fixes it, because the shape is fine;
 * it is the vocabulary that must be closed.
 *
 * So nothing here is derived from the schema. Every source and every field is
 * written out by hand, and the compiler will only emit a query built from these
 * entries. A field that is not in this file cannot be filtered on, sorted by,
 * grouped by, or displayed, no matter what a config says.
 *
 * WHAT IS DELIBERATELY ABSENT, and this is the interesting part:
 *
 *   - Contact details. `email` and `phone` exist on Lead, Contact and elsewhere
 *     and are exactly what someone would want on a "leads to call" card. They
 *     are not offered. A dashboard is a screen people leave open in a shared
 *     office and screenshot into chats; a list card is not the place to bulk-
 *     export a marketing list. The record pages remain the way to reach them,
 *     where opening one is an auditable act rather than an ambient display.
 *   - Signing tokens, IPs, user agents, PDF hashes, raw intake payloads. Not
 *     business data — they exist for tamper evidence, and putting them on a
 *     screen only helps someone attacking the signing flow.
 *   - Free-text notes. `notes`, `research`, `deleteReason`, `checkinNotes`.
 *     These hold whatever a rep typed, which in practice includes prices,
 *     personal circumstances and opinions about the customer. Truncated into a
 *     card column they are all downside.
 *
 * WHY THIS FILE IS PURE. No Prisma import, no `server-only`. Same reason as
 * registry.ts: the rules here are the ones most worth testing, and a module that
 * constructs a PrismaClient cannot be imported by `node --test`. The binding
 * from `path` to an actual query lives in ./compile.ts, and a guard fails the
 * build if the two disagree.
 */
import type { PermissionKey } from "@/lib/permissions";
import type { ModuleId } from "@/lib/modules/registry";

/* ── field types ──────────────────────────────────────────────────── */

/**
 * What KIND of value a field holds, which decides three things at once: the
 * operators the editor offers, the input control it shows, and how the renderer
 * formats it. Keeping those three in step is the whole reason this is a closed
 * union rather than a free-text hint.
 */
export type FieldType =
  | "text"
  | "number"
  /** Integer cents. Filtered in rands, stored and compared in cents. */
  | "money"
  | "date"
  /** A closed set — the editor shows a picker, not a text box. */
  | "enum"
  | "boolean"
  /** A user id. The editor offers people; the renderer shows names. */
  | "user"
  /** A named related record (stage, product). Displayed, filtered by id. */
  | "relation";

export type FieldOption = { value: string; label: string };

export type SourceField = {
  /** Stable id used in saved configs. Renaming one is a breaking change. */
  key: string;
  label: string;
  type: FieldType;
  /**
   * The Prisma path this maps to, dotted for a relation hop
   * (`stage.name`). The compiler turns this into a `select` and, for filters,
   * into a nested `where`. Never interpolated into raw SQL.
   */
  path: string;
  /**
   * EXTRA paths joined into the displayed value, for fields that are one thing
   * to a human and several columns in the database.
   *
   * A person's name is the case that forces this. `Contact` stores `firstName`,
   * `lastName` and `company`, and five of the six sources reach a person
   * through a relation. Offering those as three columns would put "Jane",
   * "Mudau" and an empty company in three cells of a card that has room for
   * four columns total, which is not a name — it is a spreadsheet.
   *
   * The renderer joins the non-empty parts with a space. A composite is
   * therefore NOT filterable and NOT sortable: "surname contains 'du'" and
   * "company contains 'du'" are different questions and a joined value cannot
   * answer either honestly. Filter on the underlying column instead — that is
   * what `firstName` and `company` are separately listed for.
   */
  paths?: readonly string[];
  /** Fixed choices for an `enum` field. */
  options?: readonly FieldOption[];
  /** May a filter be written against it? Defaults true. */
  filterable?: boolean;
  /** May a card sort by it? Defaults true. Relation hops are opt-in. */
  sortable?: boolean;
  /**
   * May a chart group by it? Only low-cardinality fields — grouping by a name
   * or a date produces a chart with one bar per row, which is not a chart.
   */
  groupable?: boolean;
  /** May a metric sum or average it? Numbers and money only. */
  aggregatable?: boolean;
  /**
   * An EXTRA permission beyond the source's own gate. Deal value is the case
   * this exists for: someone may legitimately see that a lead exists and who
   * owns it without being trusted with what it is worth.
   */
  permission?: PermissionKey;
};

/* ── sources ──────────────────────────────────────────────────────── */

export type SourceId =
  | "leads"
  | "quotes"
  | "activities"
  | "contacts"
  | "jobcards"
  | "vehicles";

/**
 * How rows are narrowed to the ones this viewer may see.
 *
 *   - `ids`: an accessible-id helper in lib/permissions returns the allowed set
 *     (null = unrestricted). This is the same scoping the record LIST pages use,
 *     which is the point — a card must not be a way around the page.
 *   - `owner`: the source has no id helper, so a field on the row names the
 *     owner directly. Used by activities, which are assigned rather than shared.
 */
export type SourceScope =
  | { by: "ids"; helper: "lead" | "contact" | "quote" | "vehicle" | "jobcard" }
  | { by: "owner"; field: string };

export type SourceDef = {
  id: SourceId;
  label: string;
  /** Plural noun for empty states: "No leads match." */
  noun: string;
  /** ANY of these grants the source. Mirrors the record page's own gate. */
  permissions: readonly PermissionKey[];
  module?: ModuleId;
  scope: SourceScope;
  /**
   * Excluded from every query this source produces, always, silently.
   *
   * Soft-deleted rows are in the Trash, which is a screen with its own
   * permission and its own audit trail. A card that could be pointed at deleted
   * records would be a way to read the Trash without holding that permission —
   * and worse, to keep reading a record someone deleted precisely because it
   * should stop being visible. There is no config option to turn this off.
   */
  softDelete: boolean;
  /** The date field a relative period filters on. */
  dateField: string;
  /** Sort applied when the config names none. */
  defaultSort: { field: string; dir: "asc" | "desc" };
  /** Columns a new list card starts with. */
  defaultColumns: readonly string[];
  /** Where a row links to. `:id` is substituted. */
  href: string;
  fields: readonly SourceField[];
};

const LEAD_STATUS = [
  { value: "open", label: "Open" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
] as const;

const QUOTE_STATUS = [
  { value: "draft", label: "Draft" },
  { value: "sent", label: "Sent" },
  { value: "accepted", label: "Accepted" },
  { value: "declined", label: "Declined" },
] as const;

const ACTIVITY_STATUS = [
  { value: "planned", label: "Planned" },
  { value: "done", label: "Done" },
  { value: "canceled", label: "Cancelled" },
] as const;

const ACTIVITY_TYPE = [
  { value: "call", label: "Call" },
  { value: "email", label: "Email" },
  { value: "meeting", label: "Meeting" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "todo", label: "To-do" },
] as const;

const JOBCARD_STATUS = [
  { value: "booking", label: "Booking" },
  { value: "checkin", label: "Check-in" },
  { value: "diagnosis", label: "Diagnosis" },
  { value: "approval", label: "Awaiting approval" },
  { value: "repair", label: "In repair" },
  { value: "qc", label: "Quality check" },
  { value: "ready", label: "Ready" },
  { value: "collected", label: "Collected" },
  { value: "cancelled", label: "Cancelled" },
] as const;

const JOBCARD_PRIORITY = [
  { value: "low", label: "Low" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
] as const;

const LEAD_SOURCE = [
  { value: "manual", label: "Added by hand" },
  { value: "facebook", label: "Facebook" },
  { value: "instagram", label: "Instagram" },
  { value: "website", label: "Website" },
] as const;

export const SOURCES: readonly SourceDef[] = [
  {
    id: "leads",
    label: "Leads",
    noun: "leads",
    permissions: ["leads.view_all", "leads.view_owned"],
    scope: { by: "ids", helper: "lead" },
    softDelete: true,
    dateField: "createdAt",
    defaultSort: { field: "createdAt", dir: "desc" },
    defaultColumns: ["name", "stage", "value", "owner"],
    href: "/leads/:id",
    fields: [
      { key: "title", label: "Title", type: "text", path: "title", groupable: false },
      { key: "name", label: "Name", type: "text", path: "name", groupable: false },
      { key: "status", label: "Status", type: "enum", path: "status", options: LEAD_STATUS, groupable: true },
      { key: "source", label: "Source", type: "enum", path: "source", options: LEAD_SOURCE, groupable: true },
      { key: "stage", label: "Stage", type: "relation", path: "stage.name", groupable: true, sortable: false },
      { key: "product", label: "Product", type: "relation", path: "product.name", groupable: true, sortable: false },
      // Deal value carries its own gate — see SourceField.permission. Someone
      // running the diary needs to see that a lead exists without being told
      // what it is worth.
      { key: "value", label: "Value", type: "money", path: "valueCents", aggregatable: true, permission: "leads.view_all" },
      { key: "quantity", label: "Quantity", type: "number", path: "quantity", aggregatable: true },
      { key: "owner", label: "Owner", type: "user", path: "assignedToId", groupable: true },
      { key: "createdAt", label: "Created", type: "date", path: "createdAt" },
      { key: "updatedAt", label: "Last updated", type: "date", path: "updatedAt" },
      { key: "stageEnteredAt", label: "In stage since", type: "date", path: "stageEnteredAt" },
      { key: "viewedAt", label: "First opened", type: "date", path: "viewedAt" },
      { key: "lostReason", label: "Lost reason", type: "text", path: "lostReason", groupable: true },
    ],
  },
  {
    id: "quotes",
    label: "Quotes",
    noun: "quotes",
    permissions: ["quotes.view_all", "quotes.view_owned"],
    scope: { by: "ids", helper: "quote" },
    softDelete: true,
    dateField: "createdAt",
    defaultSort: { field: "createdAt", dir: "desc" },
    defaultColumns: ["number", "status", "contact", "createdAt"],
    href: "/quotes/:id",
    fields: [
      { key: "number", label: "Number", type: "number", path: "number" },
      { key: "status", label: "Status", type: "enum", path: "status", options: QUOTE_STATUS, groupable: true },
      { key: "contact", label: "Customer", type: "relation", path: "contact.firstName", paths: ["contact.lastName", "contact.company"], filterable: false, sortable: false, groupable: false },
      { key: "lead", label: "Lead", type: "relation", path: "lead.name", sortable: false, groupable: false },
      { key: "owner", label: "Owner", type: "user", path: "lead.assignedToId", groupable: true, sortable: false },
      { key: "createdAt", label: "Created", type: "date", path: "createdAt" },
      { key: "validUntil", label: "Valid until", type: "date", path: "validUntil" },
      { key: "signedAt", label: "Signed", type: "date", path: "signedAt" },
      { key: "viewedAt", label: "Opened by customer", type: "date", path: "viewedAt" },
      { key: "declinedAt", label: "Declined", type: "date", path: "declinedAt" },
      { key: "invoicedAt", label: "Invoiced", type: "date", path: "invoicedAt" },
      { key: "depositPaidAt", label: "Deposit paid", type: "date", path: "depositPaidAt" },
      { key: "deliveryScheduledFor", label: "Delivery booked for", type: "date", path: "deliveryScheduledFor" },
      { key: "deliveredAt", label: "Delivered", type: "date", path: "deliveredAt" },
      { key: "supersededAt", label: "Superseded", type: "date", path: "supersededAt" },
    ],
  },
  {
    id: "activities",
    label: "Activities",
    noun: "activities",
    permissions: ["activities.view", "activities.manage"],
    // No accessible-id helper exists for activities, and inventing one would be
    // the wrong shape: an activity is ASSIGNED to exactly one person rather than
    // shared through a team, so ownership is a column on the row.
    scope: { by: "owner", field: "assignedToId" },
    softDelete: false,
    dateField: "dueDate",
    defaultSort: { field: "dueDate", dir: "asc" },
    defaultColumns: ["summary", "type", "dueDate", "owner"],
    href: "/calendar",
    fields: [
      { key: "summary", label: "Summary", type: "text", path: "summary", groupable: false },
      { key: "type", label: "Type", type: "enum", path: "type", options: ACTIVITY_TYPE, groupable: true },
      { key: "status", label: "Status", type: "enum", path: "status", options: ACTIVITY_STATUS, groupable: true },
      { key: "category", label: "Calendar", type: "text", path: "category", groupable: true },
      { key: "dueDate", label: "Due", type: "date", path: "dueDate" },
      { key: "doneAt", label: "Completed", type: "date", path: "doneAt" },
      { key: "owner", label: "Assigned to", type: "user", path: "assignedToId", groupable: true },
      { key: "lead", label: "Lead", type: "relation", path: "lead.name", sortable: false, groupable: false },
      { key: "contact", label: "Contact", type: "relation", path: "contact.firstName", paths: ["contact.lastName", "contact.company"], filterable: false, sortable: false, groupable: false },
      { key: "createdAt", label: "Created", type: "date", path: "createdAt" },
    ],
  },
  {
    id: "contacts",
    label: "Contacts",
    noun: "contacts",
    permissions: ["contacts.view_all", "contacts.view_owned"],
    scope: { by: "ids", helper: "contact" },
    softDelete: true,
    dateField: "createdAt",
    defaultSort: { field: "createdAt", dir: "desc" },
    defaultColumns: ["name", "city", "source", "createdAt"],
    href: "/contacts/:id",
    fields: [
      // The joined display name, plus the parts as their own filterable
      // columns — see SourceField.paths for why both exist.
      { key: "name", label: "Name", type: "text", path: "firstName", paths: ["lastName", "company"], filterable: false, sortable: false, groupable: false },
      { key: "firstName", label: "First name", type: "text", path: "firstName", groupable: false },
      { key: "lastName", label: "Surname", type: "text", path: "lastName", groupable: false },
      { key: "company", label: "Company", type: "text", path: "company", groupable: true },
      { key: "isCompany", label: "Is a business", type: "boolean", path: "isCompany", groupable: true },
      { key: "province", label: "Province", type: "text", path: "province", groupable: true },
      { key: "city", label: "City", type: "text", path: "city", groupable: true },
      { key: "suburb", label: "Suburb", type: "text", path: "suburb", groupable: true },
      { key: "source", label: "Source", type: "text", path: "source", groupable: true },
      { key: "owner", label: "Owner", type: "user", path: "ownerId", groupable: true },
      { key: "marketingOptOut", label: "Opted out of marketing", type: "boolean", path: "marketingOptOut", groupable: true },
      { key: "createdAt", label: "Added", type: "date", path: "createdAt" },
      { key: "updatedAt", label: "Last updated", type: "date", path: "updatedAt" },
    ],
  },
  {
    id: "jobcards",
    label: "Job cards",
    noun: "job cards",
    permissions: ["jobcards.view_all", "jobcards.view_owned"],
    module: "automotive",
    scope: { by: "ids", helper: "jobcard" },
    softDelete: true,
    dateField: "openedAt",
    defaultSort: { field: "openedAt", dir: "desc" },
    defaultColumns: ["number", "status", "vehicle", "technician"],
    href: "/workshop/:id",
    fields: [
      { key: "number", label: "Number", type: "number", path: "number" },
      { key: "status", label: "Stage", type: "enum", path: "status", options: JOBCARD_STATUS, groupable: true },
      { key: "priority", label: "Priority", type: "enum", path: "priority", options: JOBCARD_PRIORITY, groupable: true },
      { key: "description", label: "Work requested", type: "text", path: "description", groupable: false },
      { key: "vehicle", label: "Vehicle", type: "relation", path: "vehicle.regNumber", paths: ["vehicle.model"], filterable: false, sortable: false, groupable: false },
      { key: "contact", label: "Customer", type: "relation", path: "contact.firstName", paths: ["contact.lastName", "contact.company"], filterable: false, sortable: false, groupable: false },
      { key: "technician", label: "Technician", type: "user", path: "technicianId", groupable: true },
      { key: "bay", label: "Bay", type: "relation", path: "bay.name", sortable: false, groupable: true },
      { key: "openedAt", label: "Opened", type: "date", path: "openedAt" },
      { key: "completedAt", label: "Completed", type: "date", path: "completedAt" },
      { key: "estimatedHours", label: "Estimated hours", type: "number", path: "estimatedHours", aggregatable: true },
      { key: "underWarranty", label: "Under warranty", type: "boolean", path: "underWarranty", groupable: true },
      { key: "isSubcontracted", label: "Subcontracted", type: "boolean", path: "isSubcontracted", groupable: true },
    ],
  },
  {
    id: "vehicles",
    label: "Vehicles",
    noun: "vehicles",
    permissions: ["vehicles.view_all", "vehicles.view_owned"],
    module: "automotive",
    scope: { by: "ids", helper: "vehicle" },
    softDelete: true,
    dateField: "createdAt",
    defaultSort: { field: "createdAt", dir: "desc" },
    defaultColumns: ["regNumber", "model", "contact", "createdAt"],
    href: "/vehicles/:id",
    fields: [
      { key: "regNumber", label: "Registration", type: "text", path: "regNumber", groupable: false },
      { key: "model", label: "Model", type: "text", path: "model", groupable: true },
      { key: "product", label: "Product", type: "relation", path: "product.name", sortable: false, groupable: true },
      { key: "colour", label: "Colour", type: "text", path: "color", groupable: true },
      { key: "contact", label: "Owner", type: "relation", path: "contact.firstName", paths: ["contact.lastName", "contact.company"], filterable: false, sortable: false, groupable: false },
      { key: "fleet", label: "Fleet", type: "relation", path: "fleet.name", sortable: false, groupable: true },
      { key: "purchaseDate", label: "Purchased", type: "date", path: "purchaseDate" },
      { key: "warrantyMonths", label: "Warranty (months)", type: "number", path: "warrantyMonths", aggregatable: true },
      { key: "createdAt", label: "Added", type: "date", path: "createdAt" },
    ],
  },
];

const SOURCE_BY_ID = new Map<string, SourceDef>(SOURCES.map((s) => [s.id, s]));

export function sourceById(id: string): SourceDef | undefined {
  return SOURCE_BY_ID.get(id);
}

export function isSourceId(value: unknown): value is SourceId {
  return typeof value === "string" && SOURCE_BY_ID.has(value);
}

export function fieldOf(source: SourceDef, key: string): SourceField | undefined {
  return source.fields.find((f) => f.key === key);
}

/* ── what the editor may offer ────────────────────────────────────── */

export type SourceAccess = {
  permissions: ReadonlySet<string>;
  modules: ReadonlySet<string>;
};

/**
 * May this viewer build a card on this source at all?
 *
 * Identical in shape to `canSeeCard` in registry.ts, and identical for the same
 * reason: module state is a TENANT entitlement no role overrides, permission is
 * WHO, and both must pass. A source with no permissions listed would be open to
 * every signed-in user — none are, and the explicit empty check keeps a future
 * one from becoming public by omission.
 */
export function canUseSource(source: SourceDef, access: SourceAccess): boolean {
  if (source.module && !access.modules.has(source.module)) return false;
  if (source.permissions.length === 0) return false;
  return source.permissions.some((key) => access.permissions.has(key));
}

/** May this viewer see this particular column? */
export function canUseField(field: SourceField, access: SourceAccess): boolean {
  return !field.permission || access.permissions.has(field.permission);
}

/** The sources offered in the builder's first dropdown. */
export function usableSources(access: SourceAccess): SourceDef[] {
  return SOURCES.filter((s) => canUseSource(s, access));
}

/** The fields offered for this source, minus any the viewer is not trusted with. */
export function usableFields(source: SourceDef, access: SourceAccess): SourceField[] {
  return source.fields.filter((f) => canUseField(f, access));
}

/* ── operators, derived from the field type ───────────────────────── */

/**
 * Which comparisons make sense for which type.
 *
 * Derived rather than configured per field, so a new field cannot arrive with an
 * operator set nobody thought about. `contains` on an enum is absent on purpose:
 * a closed set is chosen from a list, and substring-matching a value the user
 * picked from a dropdown only produces surprises ("open" matching "reopened").
 */
export const OPERATORS_FOR_TYPE: Record<FieldType, readonly string[]> = {
  text: ["equals", "not_equals", "contains", "not_contains", "is_empty", "is_not_empty"],
  number: ["equals", "not_equals", "greater_than", "greater_or_equal", "less_than", "less_or_equal", "is_empty", "is_not_empty"],
  money: ["equals", "not_equals", "greater_than", "greater_or_equal", "less_than", "less_or_equal"],
  date: ["greater_than", "greater_or_equal", "less_than", "less_or_equal", "is_empty", "is_not_empty"],
  enum: ["equals", "not_equals", "in", "is_empty", "is_not_empty"],
  boolean: ["equals"],
  user: ["equals", "not_equals", "in", "is_empty", "is_not_empty"],
  relation: ["equals", "not_equals", "contains", "is_empty", "is_not_empty"],
};

export function operatorsFor(field: SourceField): readonly string[] {
  return OPERATORS_FOR_TYPE[field.type];
}

/* ── relative periods ─────────────────────────────────────────────── */

/**
 * The time windows a card may be scoped to, as a closed list.
 *
 * A closed list rather than an arbitrary date range because a saved dashboard is
 * long-lived: a card pinned to "1 March to 31 March" is silently wrong from
 * April onwards, and nobody notices, because a dashboard is a thing you glance
 * at rather than read. Every option here is relative, so a card configured once
 * stays true.
 */
export const PERIODS = [
  { id: "all", label: "All time" },
  { id: "today", label: "Today" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "90d", label: "Last 90 days" },
  { id: "month", label: "This month" },
  { id: "last_month", label: "Last month" },
  { id: "year", label: "This year" },
] as const;

export type PeriodId = (typeof PERIODS)[number]["id"];

export function isPeriodId(value: unknown): value is PeriodId {
  return typeof value === "string" && PERIODS.some((p) => p.id === value);
}

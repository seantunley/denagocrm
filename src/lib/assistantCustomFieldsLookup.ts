import "server-only";
import { prisma } from "./db";
import { ownedWriteTenantId } from "./tenantWrite";
import {
  getAccessibleCaseIds,
  getAccessibleContactIds,
  getAccessibleJobCardIds,
  getAccessibleLeadIds,
  getAccessibleQuoteIds,
  getAccessibleVehicleIds,
  hasAnyPermission,
  type PermissionKey,
  type PermissionUser,
} from "./permissions";
import { isModuleEnabled } from "./modules/enabled";
import type { ModuleId } from "./modules/registry";
import { contactName } from "./format";
import { getFieldDefs } from "./customFieldValues";
import { displayValue, isFieldShown, multiValues, type CustomEntity, type FieldDef, type LinkChoices, type LinkTarget } from "./customFields-helpers";

/*
 * DAX AND CUSTOM FIELDS (Sean, 2026-11-14: "DAX must have knowledge of those things, permission based").
 *
 * What a person sees on a record's page is what DAX may say about it, and nothing more:
 *  - only records they may open — the record type's own getAccessible*Ids, ANDed into every query;
 *  - only the workspace they act in — tenantId named in every query;
 *  - only ACTIVE fields, and only those "Show only when…" shows for that record (the page's own isFieldShown);
 *  - a link field names its record only when they may open THAT record too;
 *  - nothing from a module that is switched off (vehicles and job cards: Automotive; cases: Support).
 * Products and stock are left out: they have no per-record access rule to hold DAX to.
 */

/** The record types DAX reads custom fields on, how a person's access to each is decided, and its page. */
const RECORDS = {
  lead: { ids: getAccessibleLeadIds, module: null, path: "leads", view: ["leads.view_all", "leads.view_owned"], name: "leads" },
  contact: { ids: getAccessibleContactIds, module: null, path: "contacts", view: ["contacts.view_all", "contacts.view_owned"], name: "customers" },
  quote: { ids: getAccessibleQuoteIds, module: null, path: "quotes", view: ["quotes.view_all", "quotes.view_owned"], name: "quotes" },
  case: { ids: getAccessibleCaseIds, module: "support", path: "cases", view: ["cases.view_all", "cases.view_owned"], name: "help desk cases" },
  vehicle: { ids: getAccessibleVehicleIds, module: "automotive", path: "vehicles", view: ["vehicles.view_all", "vehicles.view_owned"], name: "vehicles" },
  jobcard: { ids: getAccessibleJobCardIds, module: "automotive", path: "jobcards", view: ["jobcards.view_all", "jobcards.view_owned"], name: "job cards" },
} as const satisfies Partial<Record<CustomEntity, { ids: (u: PermissionUser) => Promise<string[] | null>; module: ModuleId | null; path: string; view: readonly PermissionKey[]; name: string }>>;
export type CustomRecord = keyof typeof RECORDS;
export const CUSTOM_RECORDS = Object.keys(RECORDS) as CustomRecord[];
const BY_PATH = new Map<string, CustomRecord>(Object.entries(RECORDS).map(([entity, r]) => [r.path, entity as CustomRecord]));

/** The ones this person may open, of `ids` (null: every one they may open). [] when the module is off. */
async function openable(user: PermissionUser, entity: CustomRecord): Promise<string[] | null> {
  const record = RECORDS[entity];
  if (record.module && !(await isModuleEnabled(record.module))) return [];
  return record.ids(user);
}
const within = (allowed: string[] | null, ids: string[]) => (allowed === null ? ids : ids.filter((id) => allowed.includes(id)));

/** The names of the records link fields point at — only those this person may open (else "A record you can't open"). */
async function linkLabels(user: PermissionUser, tenantId: string, defs: FieldDef[], values: { defId: string; value: string | null }[]): Promise<LinkChoices> {
  const wanted = new Map<LinkTarget, string[]>();
  const byId = new Map(defs.map((d) => [d.id, d]));
  for (const v of values) {
    const target = byId.get(v.defId)?.linkTo;
    if (target && v.value) wanted.set(target, [...(wanted.get(target) ?? []), v.value]);
  }
  const choices: LinkChoices = {};
  for (const [target, raw] of wanted) {
    if (target === "product") {
      const rows = await prisma.product.findMany({ where: { id: { in: raw }, tenantId, deletedAt: null }, select: { id: true, name: true } });
      choices.product = rows.map((p) => ({ id: p.id, label: p.name }));
      continue;
    }
    const ids = within(await openable(user, target), raw);
    if (!ids.length) continue;
    if (target === "contact") {
      const rows = await prisma.contact.findMany({ where: { id: { in: ids }, tenantId, deletedAt: null }, select: { id: true, firstName: true, lastName: true, company: true } });
      choices.contact = rows.map((c) => ({ id: c.id, label: contactName(c) }));
    } else if (target === "lead") {
      const rows = await prisma.lead.findMany({ where: { id: { in: ids }, tenantId, deletedAt: null }, select: { id: true, title: true, name: true } });
      choices.lead = rows.map((l) => ({ id: l.id, label: `${l.name} — ${l.title}` }));
    } else {
      const rows = await prisma.vehicle.findMany({ where: { id: { in: ids }, tenantId, deletedAt: null }, select: { id: true, model: true, regNumber: true } });
      choices.vehicle = rows.map((v) => ({ id: v.id, label: [v.model, v.regNumber].filter(Boolean).join(" · ") }));
    }
  }
  return choices;
}

/**
 * Each record's filled, shown custom fields as { label: value } — only for records this person may open, in this
 * workspace. Records with none are absent from the map. Cheap when the workspace has no fields for the type.
 */
export async function customFieldsFor(user: PermissionUser, entity: CustomRecord, recordIds: string[]): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>();
  if (!recordIds.length) return out;
  const tenantId = ownedWriteTenantId();
  const defs = await getFieldDefs(entity, { tenantId });
  if (!defs.length) return out;
  const ids = within(await openable(user, entity), [...new Set(recordIds)]);
  if (!ids.length) return out;
  const values = await prisma.customFieldValue.findMany({
    where: { tenantId, defId: { in: defs.map((d) => d.id) }, recordId: { in: ids } },
    select: { defId: true, recordId: true, value: true },
  });
  const links = await linkLabels(user, tenantId, defs, values);
  const defsByKey = new Map(defs.map((d) => [d.key, d]));
  const keyOf = new Map(defs.map((d) => [d.id, d.key]));
  for (const id of ids) {
    const own = values.filter((v) => v.recordId === id);
    if (!own.length) continue;
    const byKey = new Map(own.map((v) => [keyOf.get(v.defId)!, v.value]));
    const shown: Record<string, string> = {};
    for (const def of defs) {
      const value = byKey.get(def.key) ?? null;
      if (value == null || value === "" || !isFieldShown(def, defsByKey, byKey)) continue;
      shown[def.label] = displayValue(def, value, links);
    }
    if (Object.keys(shown).length) out.set(id, shown);
  }
  return out;
}

/** The lookups whose rows ARE records (a lead, its quotes, its customer, a vehicle) — they carry their custom fields. */
export const CUSTOM_FIELD_TOOLS = new Set(["find_leads", "lead_brief", "find_quotes", "vehicles"]);
const RECORD_LINK = /^\/([a-z]+)\/([A-Za-z0-9_-]{8,40})$/;

/**
 * Adds `customFields` to every row of a lookup's results that is a record (its `link` is `/leads/<id>`, `/quotes/<id>`,
 * …), at the top level and one level down (a lead's quotes, its customer records). Never throws: a failure leaves the
 * results as they were.
 */
export async function withCustomFields(user: PermissionUser, data: unknown[]): Promise<void> {
  const rows: { row: Record<string, unknown>; entity: CustomRecord; id: string }[] = [];
  const take = (v: unknown) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return;
    const row = v as Record<string, unknown>;
    const m = typeof row.link === "string" ? RECORD_LINK.exec(row.link) : null;
    const entity = m ? BY_PATH.get(m[1]) : undefined;
    if (m && entity) rows.push({ row, entity, id: m[2] });
  };
  for (const item of data) {
    take(item);
    if (item && typeof item === "object") for (const v of Object.values(item)) if (Array.isArray(v)) v.forEach(take);
  }
  for (const entity of new Set(rows.map((r) => r.entity))) {
    const mine = rows.filter((r) => r.entity === entity);
    const fields = await customFieldsFor(user, entity, mine.map((r) => r.id));
    for (const r of mine) if (fields.has(r.id)) r.row.customFields = fields.get(r.id);
  }
}

/* ── custom_fields: list records by a custom field ─────────────────────────────────── */

/** At most this many values of one field are read for a custom_fields search. */
export const SCAN_MAX = 1000;
export type CustomFieldsArgs ={ record: CustomRecord; field?: string; value?: string; limit?: number };
type Output = { rows: { label: string; detail: string; href: string }[]; data: unknown[]; truncated: boolean };
const note = (text: string, extra: Record<string, unknown> = {}): Output => ({ truncated: false, rows: [], data: [{ note: text, ...extra }] });

/** What a stored value matches: its words, as the page shows them (a tick list by any option, a checkbox by yes/no). */
export function valueMatches(def: FieldDef, stored: string, wanted: string): boolean {
  const w = wanted.trim().toLowerCase();
  if (def.type === "checkbox") return (stored === "true") === /^(yes|true|ticked|y|1)$/.test(w);
  const shown = def.type === "multiselect" ? multiValues(stored).join(", ") : stored;
  return shown.toLowerCase().includes(w);
}

/** Labels of the records of one type, for those ids (already narrowed to what the person may open). */
async function recordLabels(entity: CustomRecord, tenantId: string, ids: string[]): Promise<Map<string, string>> {
  const where = { id: { in: ids }, tenantId };
  switch (entity) {
    case "lead":
      return new Map((await prisma.lead.findMany({ where: { ...where, deletedAt: null }, select: { id: true, name: true, title: true } })).map((l) => [l.id, `${l.name} — ${l.title}`]));
    case "contact":
      return new Map((await prisma.contact.findMany({ where: { ...where, deletedAt: null }, select: { id: true, firstName: true, lastName: true, company: true } })).map((c) => [c.id, contactName(c)]));
    case "quote":
      return new Map((await prisma.quote.findMany({ where: { ...where, deletedAt: null }, select: { id: true, number: true, contact: { select: { firstName: true, lastName: true, company: true } } } })).map((q) => [q.id, `Q-${q.number}${q.contact ? ` — ${contactName(q.contact)}` : ""}`]));
    case "case":
      return new Map((await prisma.customerCase.findMany({ where, select: { id: true, number: true, subject: true } })).map((c) => [c.id, `C-${c.number.toString()} — ${c.subject}`]));
    case "vehicle":
      return new Map((await prisma.vehicle.findMany({ where: { ...where, deletedAt: null }, select: { id: true, model: true, regNumber: true } })).map((v) => [v.id, [v.model, v.regNumber].filter(Boolean).join(" · ")]));
    case "jobcard":
      return new Map((await prisma.jobCard.findMany({ where: { ...where, deletedAt: null }, select: { id: true, number: true } })).map((j) => [j.id, `Job card ${j.number}`]));
  }
}

/**
 * "Which leads came from the Paarl expo?" — records of one type by one custom field (and a value). With no field:
 * the fields that type has, so DAX knows what can be asked.
 */
export async function customFieldsLookup(user: PermissionUser, args: CustomFieldsArgs): Promise<Output> {
  const tenantId = ownedWriteTenantId();
  const record = RECORDS[args.record];
  if (record.module && !(await isModuleEnabled(record.module))) return note(`${args.record === "case" ? "The help desk isn't" : "Vehicles aren't"} switched on for this workspace.`);
  // ACCESS FIRST, before a single definition is read (review of #1105): no right to read this record type → refused,
  // with no labels, types, options or rules. Allowed to read it but with no records yet → the fields, as the record
  // form itself would show them.
  if (!(await hasAnyPermission(user, ...record.view))) return note(`You don't have access to ${record.name}.`);
  const allowed = await openable(user, args.record);
  const defs = await getFieldDefs(args.record, { tenantId });
  const fields = defs.map((d) => ({ field: d.label, type: d.type, ...(d.options.length ? { options: d.options } : {}), ...(d.showWhen ? { shownOnlyWhen: `${defs.find((x) => x.key === d.showWhen!.key)?.label ?? d.showWhen.key} ${d.showWhen.op.replace("_", " ")}${d.showWhen.value ? ` ${d.showWhen.value}` : ""}` } : {}) }));
  if (!defs.length) return note(`This workspace has no custom fields on ${args.record}s.`);
  if (!args.field) return { truncated: false, rows: [], data: [{ record: args.record, fields }] };
  const wanted = args.field.trim().toLowerCase();
  const def = defs.find((d) => d.label.toLowerCase() === wanted) ?? defs.find((d) => d.label.toLowerCase().includes(wanted) || d.key === wanted);
  if (!def) return note(`No custom field on ${args.record}s is called "${args.field}".`, { fields });

  if (allowed !== null && !allowed.length) return note(`You have no ${record.name} you can open.`);
  // BOUNDED (review of #1105): the value is matched in the database where it can be (a checkbox by yes/no, anything
  // else by its words), newest change first, and at most SCAN_MAX are read — past that the total is "at least".
  const wantedValue = args.value?.trim();
  // The database filter only ever narrows to a SUPERSET of what valueMatches accepts (re-review of #1105): a tick
  // list is stored as JSON (["Paarl","Stellenbosch"]) but matched as shown ("Paarl, Stellenbosch"), so each
  // comma-separated part is looked for on its own and valueMatches decides.
  const parts = wantedValue?.split(",").map((p) => p.trim()).filter(Boolean) ?? [];
  const valueWhere = !wantedValue ? [] : def.type === "checkbox"
    ? [{ value: /^(yes|true|ticked|y|1)$/i.test(wantedValue) ? "true" : "false" }]
    : def.type === "multiselect" && parts.length
      ? [{ OR: parts.map((part) => ({ value: { contains: part, mode: "insensitive" as const } })) }]
      : [{ value: { contains: wantedValue, mode: "insensitive" as const } }];
  const read = await prisma.customFieldValue.findMany({
    where: {
      tenantId,
      defId: def.id,
      // AND, never spread: what was asked for must never replace the access filter.
      AND: [...(allowed === null ? [] : [{ recordId: { in: allowed } }]), { value: { not: null } }, ...valueWhere],
    },
    orderBy: { updatedAt: "desc" },
    take: SCAN_MAX + 1,
    select: { recordId: true, value: true },
  });
  const capped = read.length > SCAN_MAX;
  const values = read.slice(0, SCAN_MAX);
  // Every field of the matching records (at most SCAN_MAX), so "Show only when…" is judged as the page judges it.
  const all = values.length
    ? await prisma.customFieldValue.findMany({ where: { tenantId, defId: { in: defs.map((d) => d.id) }, recordId: { in: values.map((v) => v.recordId) } }, select: { defId: true, recordId: true, value: true } })
    : [];
  const defsByKey = new Map(defs.map((d) => [d.key, d]));
  const keyOf = new Map(defs.map((d) => [d.id, d.key]));
  const shownOn = (recordId: string) => isFieldShown(def, defsByKey, new Map(all.filter((v) => v.recordId === recordId).map((v) => [keyOf.get(v.defId)!, v.value])));
  const matching = values.filter((v) => v.value && v.value !== "" && shownOn(v.recordId) && (!args.value || valueMatches(def, v.value, args.value)));
  const labels = await recordLabels(args.record, tenantId, matching.map((v) => v.recordId));
  const links = await linkLabels(user, tenantId, defs, matching.map((v) => ({ defId: def.id, value: v.value })));
  // A record that is deleted (no label) is not listed.
  const live = matching.filter((v) => labels.has(v.recordId));
  const take = Math.min(args.limit ?? 25, 50);
  const page = live.slice(0, take);
  return {
    truncated: capped || live.length > take,
    data: [
      {
        record: args.record,
        field: def.label,
        ...(args.value ? { value: args.value } : {}),
        total: capped ? `at least ${live.length}` : live.length,
        listed: page.length,
        ...(capped ? { partial: `Only the ${SCAN_MAX} most recently changed values were read, so this is not every match — say so, and ask for a narrower value for the rest.` } : {}),
      },
      ...page.map((v) => ({ link: `/${record.path}/${v.recordId}`, name: labels.get(v.recordId), [def.label]: displayValue(def, v.value, links) })),
    ],
    rows: page.map((v) => ({ label: labels.get(v.recordId) ?? args.record, detail: `${def.label}: ${displayValue(def, v.value, links)}`, href: `/${record.path}/${v.recordId}` })),
  };
}

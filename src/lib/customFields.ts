import "server-only";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { getAccessibleContactIds, getAccessibleLeadIds, getAccessibleVehicleIds } from "@/lib/permissions";
import { contactName } from "@/lib/format";
import {
  normalizeDef,
  type CustomEntity,
  type FieldDef,
  type FieldWithValue,
  type DefRow,
  type LinkChoice,
  type LinkChoices,
  type LinkTarget,
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
export * from "./customFieldValues";

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

// ─── Link-to-a-record fields ─────────────────────────────────────────

// ponytail: the lead / vehicle pickers list the 500 most recent records the viewer
// may see (plus whatever is already linked); add a search box like ContactPicker if
// a workspace outgrows that.
const LINK_LIST_CAP = 500;

const narrow = (ids: string[] | null) => (ids === null ? {} : { id: { in: ids } });

/**
 * The records each link field on a form may point at, limited to what the
 * current viewer may open. Contacts are searched live by the picker, so only the
 * already-linked ones are preloaded. A linked record the viewer may not open is
 * left out, so it shows as "a record you can't open" rather than leaking its name.
 */
export async function loadLinkChoices(fields: FieldWithValue[], tenantId: string): Promise<LinkChoices> {
  const targets = new Set(fields.map((f) => f.def.linkTo).filter((t): t is LinkTarget => t != null));
  if (targets.size === 0) return {};
  const user = await getCurrentUser();
  if (!user) return {};
  const linked = (target: LinkTarget) =>
    fields.filter((f) => f.def.linkTo === target && f.value).map((f) => f.value as string);
  const choices: LinkChoices = {};
  // EVERY list names the workspace (review of #1064): an owner's "all records" is
  // `null` from getAccessible*Ids, which with enforcement dormant meant every
  // workspace's records.

  if (targets.has("contact")) {
    const ids = await getAccessibleContactIds(user);
    const rows = await prisma.contact.findMany({
      where: { id: { in: linked("contact") }, tenantId, deletedAt: null, ...(ids === null ? {} : { AND: [{ id: { in: ids } }] }) },
      select: { id: true, firstName: true, lastName: true, company: true },
    });
    choices.contact = rows.map((c) => ({ id: c.id, label: contactName(c) }));
  }
  if (targets.has("lead")) {
    const ids = await getAccessibleLeadIds(user);
    const rows = await prisma.lead.findMany({
      where: { tenantId, deletedAt: null, ...narrow(ids) },
      select: { id: true, title: true, name: true },
      orderBy: { updatedAt: "desc" },
      take: LINK_LIST_CAP,
    });
    choices.lead = await withLinked(rows.map((l) => ({ id: l.id, label: l.title || l.name })), linked("lead"), async (missing) =>
      (await prisma.lead.findMany({ where: { id: { in: missing }, tenantId, deletedAt: null, ...narrow(ids) }, select: { id: true, title: true, name: true } }))
        .map((l) => ({ id: l.id, label: l.title || l.name })),
    );
  }
  if (targets.has("vehicle")) {
    const ids = await getAccessibleVehicleIds(user);
    const label = (v: { model: string; regNumber: string | null; vin: string | null }) =>
      [v.model, v.regNumber ?? v.vin].filter(Boolean).join(" · ");
    const select = { id: true, model: true, regNumber: true, vin: true } as const;
    const rows = await prisma.vehicle.findMany({
      where: { tenantId, deletedAt: null, ...narrow(ids) },
      select,
      orderBy: { createdAt: "desc" },
      take: LINK_LIST_CAP,
    });
    choices.vehicle = await withLinked(rows.map((v) => ({ id: v.id, label: label(v) })), linked("vehicle"), async (missing) =>
      (await prisma.vehicle.findMany({ where: { id: { in: missing }, tenantId, deletedAt: null, ...narrow(ids) }, select }))
        .map((v) => ({ id: v.id, label: label(v) })),
    );
  }
  if (targets.has("product")) {
    // THIS workspace's catalogue — the same list every member already picks from on
    // a lead or quote; inactive models stay listed so an old link still reads.
    choices.product = (await prisma.product.findMany({
      where: { tenantId, deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    })).map((p) => ({ id: p.id, label: p.name }));
  }
  return choices;
}

async function withLinked(
  list: LinkChoice[],
  linked: string[],
  load: (missing: string[]) => Promise<LinkChoice[]>,
): Promise<LinkChoice[]> {
  const have = new Set(list.map((c) => c.id));
  const missing = linked.filter((id) => !have.has(id));
  return missing.length ? [...list, ...(await load(missing))] : list;
}

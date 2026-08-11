"use server";

import { asActionResult, ActionRefusal, refuse } from "@/lib/actionResult";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { withActingTenantWrite } from "@/lib/actingScope";
import { activeTenantPredicate } from "@/lib/tenantPredicate";
import { logAudit } from "@/lib/audit";
import { softDeleteRecord } from "@/lib/trash";
import { contactName } from "@/lib/format";
import { resolveAssignableUser } from "@/lib/tenantActor";
import {
  requirePermission,
  requireContactAccess,
  hasAnyPermission,
  type PermissionUser,
} from "@/lib/permissions";
import {
  capturesVatNumber,
  contactKind,
  contactKindColumns,
  parseContactKind,
  requiresFleet,
  type ContactKind,
} from "@/lib/contactKind";

/** The type columns of the record being edited, or null when creating a new one. */
type CurrentKind = { isCompany: boolean; fleetId: string | null } | null;

/**
 * Resolve the fleet chosen on the contact form — within the caller's own TENANT,
 * and only if they are allowed to link fleets at all.
 *
 * PERMISSION. `/fleets` is guarded `anyOf: ["fleets.view", "fleets.manage"]`, and
 * a server action is reachable by POST without ever loading the page that renders
 * it, so the form hiding the dropdown is not a control. Without one of those
 * permissions a caller may not put a contact into a fleet, and may not learn a
 * fleet's name by watching it appear in the `company` field afterwards.
 *
 * The exception is a fleet the record is ALREADY in: re-submitting the value the
 * record already holds changes nothing and discloses nothing, and refusing it
 * would mean a user who can edit this contact but not view fleets cannot save the
 * contact at all without silently dropping its fleet.
 *
 * TENANT. The lookup is scoped, not checked afterwards: a fleet id belonging to
 * another workspace simply does not resolve, so a forged select value can neither
 * link a contact into a stranger's fleet nor leak that fleet's name back through
 * the `company` field below. The predicate is named explicitly because the db.ts
 * guard scopes NOTHING while tenant enforcement is off (its documented default),
 * so relying on it here would be relying on a no-op. Same idiom as
 * quickCreate.ts's requireTenantRecord, which validates the other cross-record
 * selections on this form.
 *
 * Returns the fleet, or null when nothing was chosen / it does not resolve. The
 * caller decides what an unresolved fleet means — for kind "fleet" it is a
 * refusal, never a silent downgrade to some other kind.
 */
async function resolveFleet(
  user: PermissionUser,
  formData: FormData,
  current: CurrentKind,
): Promise<{ id: string; name: string } | null> {
  const fleetId = String(formData.get("fleetId") ?? "").trim();
  if (!fleetId) return null;
  if (fleetId !== current?.fleetId && !(await hasAnyPermission(user, "fleets.view", "fleets.manage"))) {
    throw new ActionRefusal("You do not have access to fleet accounts");
  }
  return prisma.fleet.findFirst({
    where: { id: fleetId, ...activeTenantPredicate("contact fleet selection") },
    select: { id: true, name: true },
  });
}

/**
 * The customer type as the form submitted it.
 *
 * Three sources, in order of how much they actually say:
 *
 *  1. `contactKind` — the current three-way selector. Believed as submitted.
 *  2. `isCompany` — the old two-way selector, which posted one radio or the
 *     other and so is always PRESENT in such a post. Still understood: these
 *     actions are POST-reachable by anything that already had a valid form (an
 *     older cached page, an integration), and turning every such company contact
 *     into an individual would be data loss, not validation.
 *  3. Neither — the form never rendered a type selector. KEEP WHAT THE RECORD
 *     ALREADY IS. Falling back to "individual" here is the silent-downgrade bug:
 *     it strips the fleet link and the VAT number off a record whose form simply
 *     did not ask about them, which is precisely what happens to a user who
 *     cannot see fleets editing a fleet contact.
 */
function submittedKind(formData: FormData, current: CurrentKind): ContactKind {
  const raw = formData.get("contactKind");
  if (raw != null) return parseContactKind(String(raw));
  const legacy = formData.get("isCompany");
  if (legacy != null) return legacy === "on" ? "business" : "individual";
  return current ? contactKind(current) : "individual";
}

function contactData(
  formData: FormData,
  kind: ContactKind,
  fleet: { id: string; name: string } | null,
  owner: { id: string } | null,
) {
  const str = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    return v === "" ? null : v;
  };
  // isCompany + fleetId are derived from the ONE selector, never read
  // independently — see lib/contactKind.ts for the mapping and why isCompany
  // stayed a boolean AND why it stays FALSE for a fleet contact.
  const { isCompany, fleetId } = contactKindColumns(kind, fleet?.id ?? null);
  return {
    isCompany,
    fleetId,
    firstName: String(formData.get("firstName") ?? "").trim(),
    lastName: str("lastName"),
    // A fleet member's employer IS the fleet, so the name comes from the record
    // we just resolved rather than from the request — the browser only ever
    // submits the fleet id. Safe to copy precisely because `isCompany` is false
    // for a fleet contact: `contactName()` only substitutes `company` for the
    // person's name when the record claims to BE a company.
    company: fleet ? fleet.name : str("company"),
    // VAT belongs to the entity a quote is addressed to. For a business contact
    // that is this record; for a fleet contact it is the Fleet record, so a copy
    // here would be a second number free to drift from it. Clearing it on the
    // kinds that do not capture it stops a stale number surviving a change of
    // type on a record where the field is no longer even shown.
    vatNumber: capturesVatNumber(kind) ? str("vatNumber") : null,
    email: str("email"),
    phone: str("phone"),
    whatsapp: str("whatsapp"),
    address: str("address"),
    suburb: str("suburb"),
    city: str("city"),
    province: str("province"),
    postalCode: str("postalCode"),
    source: str("source"),
    notes: str("notes"),
    // The owner arrives ALREADY resolved through tenant membership, exactly like
    // the fleet above, because reading it straight off the form here was the
    // defect: `User` is a global model, so a posted `ownerId` from another
    // workspace was persisted onto this workspace's contact without anything
    // ever looking the person up. Taking the resolved record instead of the raw
    // field means the unvalidated value has no way back into the write.
    ownerId: owner?.id ?? null,
    marketingOptOut: formData.get("marketingOptOut") === "on",
  };
}

const TAG_PALETTE = [
  "#ea580c", "#2563eb", "#059669", "#7c3aed",
  "#db2777", "#d97706", "#0891b2", "#dc2626",
];

function tagColor(name: string) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  return TAG_PALETTE[hash % TAG_PALETTE.length];
}

function parseTags(formData: FormData) {
  return [
    ...new Set(
      String(formData.get("tags") ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    ),
  ];
}

// Tag upsert + join-row insert INSIDE the caller's tenant transaction (tx). Tags
// are per-tenant unique on (tenantId, name); both the Tag and the _ContactToTag row
// are created/linked with the same owning tenant the contact gets, so no
// cross-tenant tag can be attached.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function upsertContactTagTx(tx: any, tenantId: string, name: string): Promise<string> {
  const existing = await tx.tag.findFirst({ where: { name, tenantId } });
  if (existing) return existing.id;
  const created = await tx.tag.create({ data: { name, color: tagColor(name), tenantId } });
  return created.id;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function syncContactTagsTx(tx: any, tenantId: string, contactId: string, tagNames: string[]): Promise<void> {
  for (const name of tagNames) {
    const tagId = await upsertContactTagTx(tx, tenantId, name);
    await tx.$executeRaw`INSERT INTO "_ContactToTag" ("A","B") VALUES (${contactId},${tagId}) ON CONFLICT DO NOTHING`;
  }
}

export async function createContact(formData: FormData) {
  return asActionResult(async () => {
    const user = await requirePermission("contacts.create");
    // No existing record, so there is no current kind to preserve and no
    // already-linked fleet to grandfather in.
    const kind = submittedKind(formData, null);
    const fleet = await resolveFleet(user, formData, null);
    if (requiresFleet(kind) && !fleet) {
      throw new ActionRefusal("Choose which fleet this contact belongs to");
    }
    // Resolved through TenantMember, never trusted as posted — see the shared
    // contract in lib/assignableUser.ts.
    const owner = await resolveAssignableUser(formData.get("ownerId"), "owner");
    const data = contactData(formData, kind, fleet, owner);
    if (!data.firstName) throw new ActionRefusal("Name is required");
    const tags = parseTags(formData);
    // Atomic: contact + all its tag links in ONE transaction, tenant-stamped.
    const contact = await withActingTenantWrite(async (tx, tenantId) => {
      const c = await tx.contact.create({ data: { ...data, createdById: user.id, tenantId } });
      await syncContactTagsTx(tx, tenantId, c.id, tags);
      return c;
    });
    await logAudit({
      action: "contact.created",
      summary: `Created contact ${contactName(contact)}`,
      contactId: contact.id,
      user,
    });
    revalidatePath("/contacts");
    return { redirectTo: `/contacts/${contact.id}` };
  });
}

export async function updateContact(id: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requireContactAccess(id, "contacts.edit");
    // The record's CURRENT type columns, read inside the caller's own tenant.
    // Two jobs: a form that never rendered the type selector must not reset them
    // (see submittedKind), and a fleet the contact is already in stays savable by
    // someone who cannot browse fleets. Resolving it here also means the update
    // below can no longer be aimed at another workspace's contact by id.
    const current = await prisma.contact.findFirst({
      where: { id, ...activeTenantPredicate("contact update") },
      select: { isCompany: true, fleetId: true },
    });
    if (!current) refuse("That contact could not be found.");
    const kind = submittedKind(formData, current);
    const fleet = await resolveFleet(user, formData, current);
    if (requiresFleet(kind) && !fleet) {
      throw new ActionRefusal("Choose which fleet this contact belongs to");
    }
    // Same membership check as on create. An edit is the easier attack of the
    // two: the record already exists, so a single forged field on an otherwise
    // ordinary save was enough to hand it to somebody in another workspace.
    const owner = await resolveAssignableUser(formData.get("ownerId"), "owner");
    const data = contactData(formData, kind, fleet, owner);
    if (!data.firstName) throw new ActionRefusal("Name is required");
    const tags = parseTags(formData);
    // Contact fields via the scoped client (RLS scopes the row to the tenant, and
    // matches legacy rows regardless of tenantId when enforcement is off). Tag
    // replacement is atomic: clear + re-add in ONE transaction, so a mid-way failure
    // can never leave the contact stripped of its tags.
    // READ FIRST, so the audit can say WHAT changed.
    //
    // Without a before/after pair `changedFields` diffs nothing against nothing
    // and stores an empty list, so the trail records only that "details were
    // updated" — no field, no old value, no new one. That is the entry someone
    // opens months later to find out who changed a phone number, and it could
    // not answer.
    const before = await prisma.contact.findUnique({ where: { id } });
    const contact = await prisma.contact.update({ where: { id }, data });
    await withActingTenantWrite(async (tx, actingTenantId) => {
      // The tags belong to the CONTACT, not to whoever is editing it. An admin
      // editing another workspace's contact must not re-own its tag links, and a
      // contact that predates tenancy keeps its NULL until a backfill claims it.
      const tenantId = contact.tenantId ?? actingTenantId;
      await tx.$executeRaw`DELETE FROM "_ContactToTag" WHERE "A" = ${id}`;
      await syncContactTagsTx(tx, tenantId, id, tags);
    });
    await logAudit({
      action: "contact.updated",
      summary: `Updated details for ${contactName(contact)}`,
      contactId: id,
      user,
      before,
      after: contact,
    });
    revalidatePath("/contacts");
    revalidatePath(`/contacts/${id}`);
    return { redirectTo: `/contacts/${id}` };
  });
}

export async function deleteContact(id: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requireContactAccess(id, "contacts.delete");
    const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
    const contact = await softDeleteRecord("contact", id, reason, user.name);
    // Nothing matched — another tenant's id, or already gone. Never audit a
    // deletion that did not happen.
    if (!contact) refuse("That contact could not be found.");
    await logAudit({
      action: "trash.deleted",
      summary: `Moved contact ${contactName(contact)} to trash — ${reason}`,
      contactId: id,
      user,
    });
    revalidatePath("/contacts");
    return { redirectTo: "/contacts" };
  });
}

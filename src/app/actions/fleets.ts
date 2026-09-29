"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { asActionResult, refuse } from "@/lib/actionResult";
import { prisma } from "@/lib/db";
import { withActingTenantWrite, withActingStaffScope } from "@/lib/actingScope";
import { actingTenantId } from "@/lib/actingTenant";
import { logAudit } from "@/lib/audit";
import { requirePermission, requireVehicleAccess, requireContactAccess } from "@/lib/permissions";
import { parseFleetType } from "@/lib/fleetTypes";

/**
 * The fleet this id names, IF the caller's own tenant owns it — otherwise a
 * refusal.
 *
 * Scoped lookup, not an after-the-fact ownership check: a fleet id from another
 * workspace never resolves, so a forged form value cannot rename a stranger's
 * fleet, read back its name, or park a vehicle in it. The tenant is named
 * explicitly because the db.ts guard scopes NOTHING while enforcement is off
 * (its documented default), so a mutation leaning on the guard alone is
 * unscoped in that mode.
 *
 * `tenantFleet` is async, so resolve through `actingTenantId()` rather than the
 * synchronous `activeTenantPredicate()`. Under enforcement a Server Action may
 * have lost its ambient ALS scope; the awaited resolver can re-derive the same
 * validated staff workspace and still gives us the explicit predicate dormant
 * mode needs. This keeps the boundary without making update/delete actions depend
 * on caller-frame scope propagation.
 *
 * Every fleet mutation below goes through this, including the ones that only
 * receive a fleet id as a bound argument — server actions are POST-reachable
 * independently of the page that rendered them, so the page's own scoping is
 * not a substitute.
 */
async function tenantFleet(id: string): Promise<{ id: string; name: string }> {
  const tenantId = await actingTenantId();
  const fleet = await prisma.fleet.findFirst({
    where: { id, tenantId },
    select: { id: true, name: true },
  });
  if (!fleet) refuse("That fleet is not available in this workspace");
  return fleet;
}

/** Trimmed form value, or null when blank — business detail fields are all optional. */
function optional(formData: FormData, key: string): string | null {
  return String(formData.get(key) ?? "").trim() || null;
}

/**
 * Bound with {@link withActingStaffScope} because this action reads the tenant scope
 * SYNCHRONOUSLY through `withActingTenantWrite`'s transaction boundary and creates
 * a new tenant-owned root record. Binding an enclosing scope keeps every nested
 * read/write on the same workspace.
 */
export async function createFleet(formData: FormData) {
  return withActingStaffScope(async () => {
  const user = await requirePermission("fleets.manage");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Give the fleet a name");
  // #15: attaching the fleet to a contact requires access to THAT contact.
  const contactId = String(formData.get("contactId") ?? "").trim() || null;
  if (contactId) await requireContactAccess(contactId, "fleets.manage");
  // Tenant-stamped on creation, like every other tenant-owned record. It was not
  // before, and that only stopped mattering because nothing filtered fleets by
  // tenant — which is no longer true: the fleet page, the fleets list and the
  // contact form's fleet picker all name the tenant now, so an unstamped fleet
  // would become invisible to its own workspace the moment enforcement is turned
  // on.
  //
  // USER-ORIGINATED: `requirePermission` above proves a signed-in person is doing
  // this, and a fleet has no parent record to inherit from — the creator's
  // workspace IS the owner. So this takes the ACTING workspace, not
  // `withTenantWrite`: that resolves `writeTenantId() ?? DEFAULT_TENANT_ID`, and
  // `writeTenantId()` is null while enforcement is dormant, so it stamped the
  // FOUNDING tenant onto a second workspace's fleets. The generic is stated
  // rather than inferred: `tx` is `any` (the helper cannot name a transaction
  // client type), so the callback's return type otherwise infers as `unknown`.
  const fleet = await withActingTenantWrite<{ id: string }>((tx, tenantId) =>
    tx.fleet.create({
      data: {
        name,
        // Validated, not just trimmed — a server action is POST-reachable without
        // the <select> that offers the options, and the value is rendered back on
        // the list and the detail header.
        type: parseFleetType(formData.get("type")),
        contactId,
        createdById: user.id,
        tenantId,
      },
    }),
  );
  await logAudit({ action: "fleet.created", summary: `Created fleet "${name}"`, user });
  redirect(`/fleets/${fleet.id}`);
  });
}

export async function updateFleet(id: string, formData: FormData) {
  return withActingStaffScope(async () => {
    const user = await requirePermission("fleets.manage");
    const fleet = await tenantFleet(id);
    // #15: reassigning the fleet's contact requires access to the destination contact.
    const contactId = String(formData.get("contactId") ?? "").trim() || null;
    if (contactId) await requireContactAccess(contactId, "fleets.manage");
    await prisma.fleet.update({
      where: { id: fleet.id },
      data: {
        name: String(formData.get("name") ?? "").trim() || "Untitled fleet",
        type: parseFleetType(formData.get("type")),
        contactId,
        notes: String(formData.get("notes") ?? "").trim() || null,
      },
    });
    await logAudit({ action: "fleet.updated", summary: `Updated fleet "${fleet.name}"`, user });
    revalidatePath(`/fleets/${id}`);
  });
}

/**
 * The fleet's BUSINESS record — registration, VAT, billing contact and address.
 *
 * Separate from updateFleet because it is a separate form on the page: saving
 * the billing address must not depend on, or silently rewrite, the name/type/
 * manager fields that the other form owns. Same permission, same tenant check,
 * same audit line as its neighbour.
 */
export async function updateFleetBusiness(id: string, formData: FormData) {
  return withActingStaffScope(async () => {
    const user = await requirePermission("fleets.manage");
    const fleet = await tenantFleet(id);
    await prisma.fleet.update({
      where: { id: fleet.id },
      data: {
        registrationNumber: optional(formData, "registrationNumber"),
        vatNumber: optional(formData, "vatNumber"),
        billingEmail: optional(formData, "billingEmail"),
        billingPhone: optional(formData, "billingPhone"),
        address: optional(formData, "address"),
        suburb: optional(formData, "suburb"),
        city: optional(formData, "city"),
        province: optional(formData, "province"),
        postalCode: optional(formData, "postalCode"),
      },
    });
    await logAudit({
      action: "fleet.updated",
      summary: `Updated business details for fleet "${fleet.name}"`,
      user,
    });
    revalidatePath(`/fleets/${id}`);
  });
}

/**
 * Soft-delete a fleet, and unlink everything that pointed at it.
 *
 * The id is a BOUND ARGUMENT, not a form field, because this is now behind
 * ConfirmDelete — which posts a typed reason and nothing else — and because an id
 * that arrives in the form body is an id a POST can substitute. It is still
 * resolved through tenantFleet either way.
 *
 * The carts and the contacts survive: a fleet is an account, and closing an
 * account is not a reason to lose the customers or the vehicles in it. They are
 * simply no longer listed under something that has gone.
 */
export async function deleteFleet(id: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requirePermission("fleets.manage");
    const fleet = await tenantFleet(id);
    const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
    await prisma.vehicle.updateMany({ where: { fleetId: fleet.id }, data: { fleetId: null } });
    // Members keep every one of their own records — they simply stop rolling up
    // onto a fleet that no longer exists. Same treatment the vehicles get above.
    await prisma.contact.updateMany({ where: { fleetId: fleet.id }, data: { fleetId: null } });
    await prisma.fleet.update({ where: { id: fleet.id }, data: { deletedAt: new Date() } });
    await logAudit({
      action: "fleet.deleted",
      summary: `Deleted fleet "${fleet.name}" — ${reason}`,
      user,
    });
    revalidatePath("/fleets");
    return { redirectTo: "/fleets" };
  });
}

export async function assignVehicleToFleet(fleetId: string, formData: FormData) {
  return withActingStaffScope(async () => {
    const vehicleId = String(formData.get("vehicleId") ?? "");
    if (!vehicleId) return;
    await requireVehicleAccess(vehicleId, "fleets.manage");
    // The DESTINATION is checked too: vehicle access alone says nothing about the
    // fleet it is being moved into.
    const fleet = await tenantFleet(fleetId);
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { fleetId: fleet.id } });
    revalidatePath(`/fleets/${fleetId}`);
  });
}

export async function removeVehicleFromFleet(vehicleId: string, fleetId: string) {
  return withActingStaffScope(async () => {
    await requireVehicleAccess(vehicleId, "fleets.manage");
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { fleetId: null } });
    revalidatePath(`/fleets/${fleetId}`);
  });
}

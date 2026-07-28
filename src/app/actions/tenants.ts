"use server";

import bcrypt from "bcryptjs";
import { revalidatePath } from "next/cache";
import { basePrisma } from "@/lib/db";
import { requirePlatformAdminAction } from "@/lib/platformAuth";
import { logAuditStrict } from "@/lib/audit";
import {
  createTenant,
  activateTenant,
  suspendTenant,
  addTenantMembership,
} from "@/lib/provisioning";
import {
  canActivateTenant,
  canSuspendTenant,
  canAddTenantMember,
  canRemoveTenantMember,
} from "@/lib/tenantAdmin";
import { serialiseModuleGrant } from "@/lib/modules/entitlement";
import { tenantEnforcing } from "@/lib/tenantEnforcement";

/** The route every action revalidates so the console reflects the new state. */
const CONSOLE_PATH = "/platform/tenants";

const value = (formData: FormData, key: string) => String(formData.get(key) ?? "").trim();

/** Same password floor as admin createUser (settings.createUser). */
function validPassword(password: string): boolean {
  return password.length >= 12 && /[A-Za-z]/.test(password) && /\d/.test(password);
}

/** A Prisma unique-constraint violation, duck-typed so this file stays crypto/ORM-light. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

/**
 * Platform-admin guard at the top of EVERY action. Server Actions are reachable by
 * direct POST, not just via this console's UI, so authorisation is re-checked here
 * regardless of what the page rendered.
 *
 * This resolves a `PlatformAdmin` — NOT a CRM `User`. A tenant's owner, including
 * the founding tenant's, has no access here unless they separately hold a platform
 * identity. Throws rather than redirecting, so a direct POST fails loudly instead
 * of being bounced to a login page it never requested.
 */
async function requirePlatformOwner(): Promise<{ id: string; name: string; email: string }> {
  return requirePlatformAdminAction();
}

export async function createTenantAction(formData: FormData): Promise<void> {
  const actor = await requirePlatformOwner();

  const name = value(formData, "name");
  const slug = value(formData, "slug").toLowerCase();
  const ownerName = value(formData, "ownerName");
  const ownerEmail = value(formData, "ownerEmail").toLowerCase();
  const password = String(formData.get("ownerPassword") ?? "");

  if (!name || !slug || !ownerName || !ownerEmail) {
    throw new Error("Tenant name, slug, owner name and owner email are all required.");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error("Slug may only contain lowercase letters, numbers and single hyphens.");
  }
  if (!validPassword(password)) {
    throw new Error("Owner password must be at least 12 characters and contain letters and numbers.");
  }

  // Friendly pre-checks for the common collisions; the createTenant transaction
  // is still the authoritative uniqueness boundary (race-safe catch below).
  const slugTaken = await basePrisma.tenant.findUnique({ where: { slug }, select: { id: true } });
  if (slugTaken) throw new Error(`A tenant with the slug “${slug}” already exists.`);
  const emailTaken = await basePrisma.user.findUnique({ where: { email: ownerEmail }, select: { id: true } });
  if (emailTaken) throw new Error("A user with that email already exists.");

  const passwordHash = await bcrypt.hash(password, 12);

  let created: { tenantId: string; ownerId: string };
  try {
    created = await createTenant(basePrisma, {
      name,
      slug,
      owner: { name: ownerName, email: ownerEmail, passwordHash },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new Error("That slug or owner email was just taken — choose another.");
    }
    throw error;
  }

  await logAuditStrict({
    action: "tenant.created",
    summary: `Created inert tenant “${name}” (${slug})`,
    entityType: "Tenant",
    entityId: created.tenantId,
    user: actor,
    // The actor is a PlatformAdmin, not a CRM User — say so, or the trail records
    // an actorUserId that resolves to nothing in the User table.
    actorType: "platform_admin",
    // No password fields here — the owner's credentials never enter the audit trail.
    after: { name, slug, active: false, ownerId: created.ownerId, ownerEmail, inert: true },
  });
  revalidatePath(CONSOLE_PATH);
}

export async function activateTenantAction(tenantId: string): Promise<void> {
  const actor = await requirePlatformOwner();

  // SAFETY GATE: refuse activation until data-isolation enforcement is live.
  const gate = canActivateTenant(tenantEnforcing());
  if (!gate.ok) throw new Error(gate.error);

  const tenant = await basePrisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true, slug: true, active: true },
  });
  if (!tenant) throw new Error("Tenant not found.");

  // The provisioned owner is the earliest TenantMember — the one createTenant
  // disabled. Every member added after creation is an existing active user whose
  // global disabledAt must not be touched by activation.
  const firstMemberRows = await basePrisma.$queryRaw<Array<{ userId: string }>>`
    SELECT "userId" FROM "TenantMember" WHERE "tenantId" = ${tenantId}
    ORDER BY "createdAt" ASC LIMIT 1
  `;
  const ownerId = firstMemberRows[0]?.userId;
  if (!ownerId) throw new Error("Tenant has no members — cannot activate.");

  await activateTenant(basePrisma, tenantId, ownerId);

  await logAuditStrict({
    action: "tenant.activated",
    summary: `Activated tenant “${tenant.name}” and re-enabled the provisioned owner`,
    entityType: "Tenant",
    entityId: tenantId,
    user: actor,
    // The actor is a PlatformAdmin, not a CRM User — say so, or the trail records
    // an actorUserId that resolves to nothing in the User table.
    actorType: "platform_admin",
    before: { active: tenant.active },
    after: { active: true },
  });
  revalidatePath(CONSOLE_PATH);
}

export async function suspendTenantAction(tenantId: string): Promise<void> {
  const actor = await requirePlatformOwner();

  // Never suspend the founding tenant — it underpins the whole existing business.
  const gate = canSuspendTenant(tenantId);
  if (!gate.ok) throw new Error(gate.error);

  const tenant = await basePrisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true, active: true },
  });
  if (!tenant) throw new Error("Tenant not found.");

  await suspendTenant(basePrisma, tenantId);

  await logAuditStrict({
    action: "tenant.suspended",
    summary: `Suspended tenant “${tenant.name}”`,
    entityType: "Tenant",
    entityId: tenantId,
    user: actor,
    // The actor is a PlatformAdmin, not a CRM User — say so, or the trail records
    // an actorUserId that resolves to nothing in the User table.
    actorType: "platform_admin",
    before: { active: tenant.active },
    after: { active: false },
  });
  revalidatePath(CONSOLE_PATH);
}

export async function addTenantMemberAction(tenantId: string, formData: FormData): Promise<void> {
  const actor = await requirePlatformOwner();

  const userId = value(formData, "userId");
  if (!userId) throw new Error("Select a user to add.");

  const [tenant, user] = await Promise.all([
    basePrisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true } }),
    basePrisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true } }),
  ]);
  if (!tenant) throw new Error("Tenant not found.");
  if (!user) throw new Error("Selected user does not exist.");

  // LOCKOUT GUARD — see tenantAdmin.canAddTenantMember. Sign-in resolves the acting
  // tenant with soleActiveTenant, which needs EXACTLY ONE active membership; a
  // second one yields `ambiguous_tenant` and, under enforcement, no session at all.
  // Granting it would remove this user's access rather than widen it.
  const activeMemberships = await basePrisma.tenantMember.findMany({
    where: { userId, tenant: { active: true } },
    select: { tenantId: true },
  });
  const addGate = canAddTenantMember(
    activeMemberships.map((membership) => membership.tenantId),
    tenantId,
  );
  if (!addGate.ok) throw new Error(addGate.error);

  await addTenantMembership(basePrisma, tenantId, userId);

  await logAuditStrict({
    action: "tenant.member_added",
    summary: `Added ${user.name} to tenant “${tenant.name}”`,
    entityType: "Tenant",
    entityId: tenantId,
    user: actor,
    // The actor is a PlatformAdmin, not a CRM User — say so, or the trail records
    // an actorUserId that resolves to nothing in the User table.
    actorType: "platform_admin",
    after: { userId },
  });
  revalidatePath(CONSOLE_PATH);
}

export async function removeTenantMemberAction(tenantId: string, userId: string): Promise<void> {
  const actor = await requirePlatformOwner();

  const tenant = await basePrisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true },
  });
  if (!tenant) throw new Error("Tenant not found.");

  // A transaction ALONE does not close the last-member race: PostgreSQL's default
  // READ COMMITTED isolation lets two concurrent removals both read count=2 and
  // then delete DIFFERENT memberships, leaving zero. Serialise them on the parent
  // TENANT row — every removal for this tenant takes the same lock, so the second
  // waits and re-counts after the first commits, seeing count=1 and being refused.
  await basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE`;

    const memberCount = await tx.tenantMember.count({ where: { tenantId } });
    const gate = canRemoveTenantMember(memberCount);
    if (!gate.ok) throw new Error(gate.error);
    await tx.tenantMember.deleteMany({ where: { tenantId, userId } });
  });

  await logAuditStrict({
    action: "tenant.member_removed",
    summary: `Removed a member from tenant “${tenant.name}”`,
    entityType: "Tenant",
    entityId: tenantId,
    user: actor,
    // The actor is a PlatformAdmin, not a CRM User — say so, or the trail records
    // an actorUserId that resolves to nothing in the User table.
    actorType: "platform_admin",
    before: { userId },
  });
  revalidatePath(CONSOLE_PATH);
}

/**
 * Grant the optional module packs a tenant MAY use. The platform admin sets the
 * outer limit here; the tenant's own admin can still switch a granted pack off for
 * themselves, but can never switch on one that was not granted.
 *
 * Revoking is immediate and unconditional — a module removed here disappears for
 * the tenant on their next request regardless of their local preference, because
 * the effective set is (granted MINUS locally disabled).
 */
export async function setTenantModulesAction(
  tenantId: string,
  formData: FormData,
): Promise<void> {
  const actor = await requirePlatformOwner();

  const tenant = await basePrisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true, modules: true },
  });
  if (!tenant) throw new Error("Tenant not found.");

  // serialiseModuleGrant drops anything that is not a known OPTIONAL module, so a
  // forged POST cannot grant "core" (already implied) or invent an id.
  const modules = serialiseModuleGrant(formData.getAll("modules").map(String));

  if (modules === tenant.modules) {
    revalidatePath(CONSOLE_PATH);
    return;
  }

  await basePrisma.tenant.update({ where: { id: tenantId }, data: { modules } });

  await logAuditStrict({
    action: "tenant.modules_changed",
    summary: `Updated modules for tenant “${tenant.name}”`,
    entityType: "Tenant",
    entityId: tenantId,
    user: actor,
    // The actor is a PlatformAdmin, not a CRM User — say so, or the trail records
    // an actorUserId that resolves to nothing in the User table.
    actorType: "platform_admin",
    before: { modules: tenant.modules },
    after: { modules },
  });
  revalidatePath(CONSOLE_PATH);
}

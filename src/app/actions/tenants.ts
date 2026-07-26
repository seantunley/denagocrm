"use server";

import bcrypt from "bcryptjs";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { basePrisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { logAuditStrict } from "@/lib/audit";
import {
  createTenant,
  activateTenant,
  suspendTenant,
  addTenantMembership,
} from "@/lib/provisioning";
import {
  isPlatformAdmin,
  canActivateTenant,
  canSuspendTenant,
  canRemoveTenantMember,
} from "@/lib/tenantAdmin";
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
 * Platform super-admin guard at the top of EVERY action. Server Actions are
 * reachable by direct POST, not just via this console's UI, so authorisation is
 * re-checked here regardless of what the page rendered. Unauthenticated callers go
 * to login; authenticated non-owners are refused hard.
 */
async function requirePlatformOwner(): Promise<{ id: string; name: string; role: string }> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!isPlatformAdmin(user.role)) throw new Error("Not authorized: platform owner access required.");
  return user;
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

  await activateTenant(basePrisma, tenantId);

  await logAuditStrict({
    action: "tenant.activated",
    summary: `Activated tenant “${tenant.name}” and re-enabled its members`,
    entityType: "Tenant",
    entityId: tenantId,
    user: actor,
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

  await addTenantMembership(basePrisma, tenantId, userId);

  await logAuditStrict({
    action: "tenant.member_added",
    summary: `Added ${user.name} to tenant “${tenant.name}”`,
    entityType: "Tenant",
    entityId: tenantId,
    user: actor,
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

  // Never remove the last member of a tenant (count BEFORE the delete).
  const memberCount = await basePrisma.tenantMember.count({ where: { tenantId } });
  const gate = canRemoveTenantMember(memberCount);
  if (!gate.ok) throw new Error(gate.error);

  await basePrisma.tenantMember.deleteMany({ where: { tenantId, userId } });

  await logAuditStrict({
    action: "tenant.member_removed",
    summary: `Removed a member from tenant “${tenant.name}”`,
    entityType: "Tenant",
    entityId: tenantId,
    user: actor,
    before: { userId },
  });
  revalidatePath(CONSOLE_PATH);
}

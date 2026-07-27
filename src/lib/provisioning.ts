import type { PrismaClient, Prisma } from "@prisma/client";
import { DEFAULT_TENANT_ID } from "./tenant";

/**
 * IDs of the 7 system roles seeded in migration 52_pipelines_forecasting_rbac_audit
 * and moved to DEFAULT_TENANT_ID in migration 20260727170000_full_tenant_scope.
 * Every newly provisioned tenant gets its own copies of these roles so RLS can
 * isolate them by tenantId.
 */
const SYSTEM_ROLE_IDS = [
  "role_crm_admin",
  "role_sales_manager",
  "role_sales_rep",
  "role_marketing",
  "role_workshop_manager",
  "role_technician",
  "role_auditor",
] as const;

/**
 * Modules a freshly-activated tenant owner gets by default — mirrors the
 * User.modules schema default. Granted by {@link activateTenant} only when the
 * owner has none yet (createTenant provisions them with an empty set).
 */
const DEFAULT_OWNER_MODULES = "crm,workshop,reports,inbox";

/**
 * Shared tenant-provisioning service. ONE place that turns "a user exists" into "a
 * user belongs to a tenant", so every creation path — initial seed, admin
 * createUser, the SQLite→Postgres data import, and future invitation/signup flows
 * — provisions membership the same way. Tenant access is fail-closed, so a user
 * created without going through here would be locked out once session enforcement
 * lands. Client is injected (no `server-only`) so tsx scripts and server actions
 * can both use it, inside or outside a transaction.
 */
type Client = PrismaClient | Prisma.TransactionClient;

/** Idempotently add a user to an EXISTING tenant.
 *  Throws if the user already belongs to a different tenant (one-user-one-tenant policy). */
export async function addTenantMembership(
  client: Client,
  tenantId: string,
  userId: string,
): Promise<void> {
  const conflict = await client.tenantMember.findFirst({
    where: { userId, NOT: { tenantId } },
    select: { tenantId: true },
  });
  if (conflict) {
    throw new Error(
      `This user already belongs to tenant "${conflict.tenantId}". A user may only be a member of one tenant.`,
    );
  }
  await client.tenantMember.upsert({
    where: { tenantId_userId: { tenantId, userId } },
    update: {},
    create: { tenantId, userId },
  });
}

/**
 * Ensure a user belongs to the founding Denago tenant, creating that tenant if
 * absent. For the SINGLE-tenant restore paths — seed + data import — where every
 * user is a Denago user. Admin createUser instead resolves the caller's validated
 * tenant context and calls {@link addTenantMembership}.
 */
export async function ensureFoundingMembership(client: Client, userId: string): Promise<void> {
  await client.tenant.upsert({
    where: { id: DEFAULT_TENANT_ID },
    update: {},
    create: { id: DEFAULT_TENANT_ID, name: "Denago Cape Town", slug: "denago-cape-town", active: true },
  });
  await addTenantMembership(client, DEFAULT_TENANT_ID, userId);
  await client.user.update({
    where: { id: userId },
    data: { tenantId: DEFAULT_TENANT_ID },
  });
}

/**
 * Copy the 7 system roles (and all their permissions) from the founding tenant
 * into a newly provisioned tenant. System roles live in DEFAULT_TENANT_ID after
 * migration 20260727170000; new tenants need per-tenant copies so tenant-scoped
 * RLS can isolate them.
 *
 * Uses deterministic per-tenant role IDs (`${sourceId}:${tenantId}`) so the
 * call is idempotent — safe to use as a repair script on an incomplete tenant.
 * Must be called via a basePrisma client (or its tx) so bypass_rls is active
 * and the source roles in DEFAULT_TENANT_ID are visible.
 */
export async function seedTenantDefaultRoles(client: Client, tenantId: string): Promise<void> {
  const sourceRoles = await client.role.findMany({
    where: { id: { in: [...SYSTEM_ROLE_IDS] } },
    include: { permissions: { select: { permissionKey: true } } },
  });

  if (sourceRoles.length !== SYSTEM_ROLE_IDS.length) {
    const found = sourceRoles.map((r) => r.id);
    const missing = SYSTEM_ROLE_IDS.filter((id) => !found.includes(id));
    throw new Error(`Default tenant roles missing from founding tenant: ${missing.join(", ")}`);
  }

  for (const source of sourceRoles) {
    const id = `${source.id}:${tenantId}`;
    await client.role.upsert({
      where: { id },
      update: {},
      create: {
        id,
        name: source.name,
        description: source.description,
        system: true,
        tenantId,
      },
    });
    if (source.permissions.length > 0) {
      await client.rolePermission.createMany({
        data: source.permissions.map((p) => ({
          roleId: id,
          permissionKey: p.permissionKey,
          tenantId,
        })),
        skipDuplicates: true,
      });
    }
  }
}

export type CreateTenantInput = {
  name: string;
  slug: string;
  owner: {
    name: string;
    email: string;
    /** Pre-hashed (bcrypt). Callers hash — this module stays crypto-free so tsx
     *  scripts and server code can both use it. */
    passwordHash: string;
  };
};

/**
 * Create a BRAND-NEW tenant with its first owner user + membership, atomically.
 * The single source of truth for tenant creation — the `create-tenant` CLI, the
 * future platform-admin UI, and the isolation tests all go through here. Requires
 * a full client (opens its own transaction). Returns the new ids.
 *
 * There is NO tenant data isolation yet, so this must not stand up a login that
 * could reach the currently-unscoped CRM. It is therefore deliberately inert:
 *   - the tenant is SUSPENDED (active:false) — fail-closed resolution filters
 *     active:true, so the owner resolves to no tenant;
 *   - the owner is DISABLED (disabledAt set) — the login flow refuses a disabled
 *     user, so the generated credentials cannot sign in;
 *   - the owner has NO modules and the non-privileged "member" role — User.role
 *     is still GLOBAL, so an "owner" here would be a cross-tenant superuser.
 * A controlled activation flow (enable the tenant AND the user) arrives with the
 * roles→membership / enforcement PR. There is intentionally no "create it live"
 * escape hatch until then. See MULTITENANCY-SCOPING.md.
 */
export async function createTenant(
  prisma: PrismaClient,
  input: CreateTenantInput,
): Promise<{ tenantId: string; ownerId: string }> {
  return prisma.$transaction(async (tx) => {
    // NB: basePrisma.$transaction sets app.bypass_rls for the whole callback, so the
    // raw `tx.$executeRaw` UPDATE (disabledAt) below is not filtered by FORCE RLS.
    const tenant = await tx.tenant.create({
      data: { name: input.name, slug: input.slug, active: false },
    });
    const owner = await tx.user.create({
      data: {
        name: input.owner.name,
        email: input.owner.email,
        passwordHash: input.owner.passwordHash,
        role: "member",
        modules: "",
        tenantId: tenant.id,
      },
    });
    await tx.tenant.update({ where: { id: tenant.id }, data: { ownerUserId: owner.id } });
    // disabledAt is a security column managed outside the Prisma model (raw SQL).
    // Disable the owner so the credentials can't log into the unscoped CRM until
    // a deliberate activation flow exists.
    await tx.$executeRaw`UPDATE "User" SET "disabledAt" = NOW() WHERE "id" = ${owner.id}`;
    await addTenantMembership(tx, tenant.id, owner.id);
    await seedTenantDefaultRoles(tx, tenant.id);
    return { tenantId: tenant.id, ownerId: owner.id };
  });
}

/**
 * ACTIVATE a tenant created inert by {@link createTenant} — the controlled inverse
 * of that function's deliberate inert setup: flip `Tenant.active` to true AND clear
 * `disabledAt` on the provisioned owner so they can finally sign in.
 *
 * `ownerId` MUST be the userId stored in `Tenant.ownerUserId` (set atomically by
 * {@link createTenant}). Only that specific account is re-enabled: other
 * TenantMembers are existing platform users whose global `disabledAt` state is
 * unrelated to this tenant's inert setup and must not be touched — a security
 * suspension on a shared account must survive a second tenant's activation.
 *
 * This module is the SINGLE source of truth for the state change, but it stays
 * enforcement-agnostic: activating before data isolation is enforced would expose
 * existing data, so the CALLER MUST gate on `tenantEnforcing()` (see
 * tenantAdmin.canActivateTenant). Requires a full client (opens its own tx).
 */
export async function activateTenant(
  prisma: PrismaClient,
  tenantId: string,
  ownerId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // basePrisma.$transaction sets app.bypass_rls for the whole callback, so the raw
    // UPDATE/INSERT below (User, UserRole — both FORCE-RLS) are not filtered away.
    await tx.tenant.update({ where: { id: tenantId }, data: { active: true } });
    // Re-enable ONLY the provisioned owner. Members added after creation are
    // existing, already-active users whose disabledAt is not ours to clear.
    await tx.$executeRaw`
      UPDATE "User" SET "disabledAt" = NULL
      WHERE "id" = ${ownerId} AND "disabledAt" IS NOT NULL
    `;
    // Give the owner a WORKING workspace. Enabling the account is not enough — a
    // bare owner has the non-privileged "member" global role, no tenant-admin
    // permissions, and (from createTenant) no modules. So:
    //   1. ensure the tenant's own role copies exist (idempotent), then
    //   2. assign the tenant-local CRM-admin role (tenant administration), and
    //   3. grant the default module set if the owner has none yet (never clobber
    //      a set customized after a prior activation).
    await seedTenantDefaultRoles(tx, tenantId);
    const adminRoleId = `role_crm_admin:${tenantId}`;
    await tx.$executeRaw`
      INSERT INTO "UserRole" ("id", "userId", "roleId", "tenantId")
      VALUES (gen_random_uuid()::text, ${ownerId}, ${adminRoleId}, ${tenantId})
      ON CONFLICT DO NOTHING
    `;
    await tx.$executeRaw`
      UPDATE "User" SET "modules" = ${DEFAULT_OWNER_MODULES}
      WHERE "id" = ${ownerId} AND ("modules" IS NULL OR "modules" = '')
    `;
    // Bump session version so any pre-existing session re-reads the new role/modules.
    await tx.$executeRaw`UPDATE "User" SET "sessionVersion" = "sessionVersion" + 1 WHERE "id" = ${ownerId}`;
  });
}

/**
 * SUSPEND a tenant — set `active` to false. Fail-closed tenant resolution filters
 * on `active`, so a suspended tenant's members resolve to no tenant and (under
 * enforcement) cannot act. Deliberately does NOT touch member `disabledAt`: this
 * is a tenant-level switch, reversible via {@link activateTenant}. The caller must
 * refuse suspending the founding tenant (see tenantAdmin.canSuspendTenant).
 */
export async function suspendTenant(prisma: PrismaClient, tenantId: string): Promise<void> {
  // Defence-in-depth at the SOURCE OF TRUTH — deliberately NOT gated on enforcement.
  // The founding tenant underpins every existing user + session, so suspending it
  // (active:false) would fail-closed lock the whole business out. The console action
  // already refuses this via tenantAdmin.canSuspendTenant; enforcing it here too means
  // suspending the founding tenant is impossible no matter which caller reaches this
  // function, enforcement on or off.
  if (tenantId === DEFAULT_TENANT_ID) {
    throw new Error("The founding tenant cannot be suspended.");
  }
  await prisma.tenant.update({ where: { id: tenantId }, data: { active: false } });
}

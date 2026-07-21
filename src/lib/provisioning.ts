import type { PrismaClient, Prisma } from "@prisma/client";
import { DEFAULT_TENANT_ID } from "./tenant";

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

/** Idempotently add a user to an EXISTING tenant. */
export async function addTenantMembership(
  client: Client,
  tenantId: string,
  userId: string,
): Promise<void> {
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
      },
    });
    // disabledAt is a security column managed outside the Prisma model (raw SQL).
    // Disable the owner so the credentials can't log into the unscoped CRM until
    // a deliberate activation flow exists.
    await tx.$executeRaw`UPDATE "User" SET "disabledAt" = NOW() WHERE "id" = ${owner.id}`;
    await addTenantMembership(tx, tenant.id, owner.id);
    return { tenantId: tenant.id, ownerId: owner.id };
  });
}

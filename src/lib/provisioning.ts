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

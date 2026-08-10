import "server-only";
import { Prisma } from "@prisma/client";
import { basePrisma } from "./db";
import { currentScopeClass } from "./tenantWrite";
import { resolveAssignment } from "./assignableUser";

export type TenantActor = { id: string; name: string; email: string };

// Actor selection classifies the current scope exactly like every other unguarded
// tenant-owned path — via the shared {@link currentScopeClass}. `global` → the
// unchanged pick (dormant OR trusted system), `tenant` → a member of that tenant,
// `closed` → resolve NOTHING (fail closed), never a global user.
const actorScope = currentScopeClass;

/**
 * Actor selection for system-generated, tenant-owned records (survey note,
 * signed-document uploader, approval notification recipient) + staff pickers.
 *
 * All selection is RAW SQL through `basePrisma`, for two reasons:
 *  - `User` is a global model, so restricting to the current tenant needs a
 *    `TenantMember` join, not the (no-op) tenant guard.
 *  - `disabledAt` (and `role`) are real `User` columns but are DELIBERATELY not in
 *    the Prisma model — they're the authoritative security state read via raw SQL
 *    (see userSecurity.ts). Every query below filters `u."disabledAt" IS NULL` so a
 *    DISABLED account is never picked, listed, or emailed a live approval token —
 *    consistently, in every mode (a token action needs no login, so disablement
 *    must be enforced at selection time).
 *
 * Scope handling is via {@link actorScope}: a tenant scope → an active member of
 * that tenant; dormant or an explicit `system` scope → the unchanged global pick
 * (still excluding disabled); enforcement on with NO scope or a null non-system
 * scope → resolve NOTHING (fail closed), never a global user.
 */
export async function resolveTenantActor(
  opts: { ownerOnly?: boolean } = {},
): Promise<TenantActor | null> {
  const s = actorScope();
  if (s.mode === "closed") return null;
  if (s.mode === "tenant") {
    const owner = opts.ownerOnly ? Prisma.sql`AND u."role" = 'owner'` : Prisma.empty;
    const rows = await basePrisma.$queryRaw<TenantActor[]>`
      SELECT u."id", u."name", u."email"
      FROM "TenantMember" m
      JOIN "User" u ON u."id" = m."userId"
      JOIN "Tenant" t ON t."id" = m."tenantId"
      WHERE m."tenantId" = ${s.tenantId} AND t."active" = true AND u."disabledAt" IS NULL ${owner}
      ORDER BY u."createdAt" ASC
      LIMIT 1`;
    return rows[0] ?? null;
  }
  const owner = opts.ownerOnly ? Prisma.sql`AND "role" = 'owner'` : Prisma.empty;
  const rows = await basePrisma.$queryRaw<TenantActor[]>`
    SELECT "id", "name", "email" FROM "User"
    WHERE "disabledAt" IS NULL ${owner}
    ORDER BY "createdAt" ASC
    LIMIT 1`;
  return rows[0] ?? null;
}

/**
 * Resolve a SPECIFIC user by id, but ONLY if they are a valid actor for the current
 * tenant — an ACTIVE, NON-DISABLED member of the current tenant scope. Used for
 * EXPLICIT staff assignees (approval steps): a stale, cross-tenant, or disabled
 * `assigneeUserId` must never be emailed this tenant's document. Scope handling via
 * {@link actorScope}: dormant or an explicit `system` scope → direct lookup (still
 * excluding disabled); a tenant scope → membership-checked lookup; enforcement with
 * no scope or a null non-system scope → null (fail closed). Returns null whenever
 * the id is not a valid current-tenant member.
 */
export async function resolveTenantMemberUser(userId: string): Promise<TenantActor | null> {
  const s = actorScope();
  if (s.mode === "closed") return null;
  if (s.mode === "tenant") {
    const rows = await basePrisma.$queryRaw<TenantActor[]>`
      SELECT u."id", u."name", u."email"
      FROM "TenantMember" m
      JOIN "User" u ON u."id" = m."userId"
      JOIN "Tenant" t ON t."id" = m."tenantId"
      WHERE m."tenantId" = ${s.tenantId} AND m."userId" = ${userId}
        AND t."active" = true AND u."disabledAt" IS NULL
      LIMIT 1`;
    return rows[0] ?? null;
  }
  const rows = await basePrisma.$queryRaw<TenantActor[]>`
    SELECT "id", "name", "email" FROM "User"
    WHERE "id" = ${userId} AND "disabledAt" IS NULL
    LIMIT 1`;
  return rows[0] ?? null;
}

/**
 * THE assignment contract: turn a posted assignee id into a person this workspace
 * may actually assign work to, or refuse.
 *
 * Every "assign this record to somebody" action should come through here rather
 * than reading the id off the form and trusting it. Three of them did trust it —
 * a contact's owner, a help desk ticket's agent, a job card's technician — and
 * because `User` is global, "does this user exist" was the only question being
 * asked. It is the wrong question: a user id from an entirely different tenant
 * answers it yes. Authorising the RECORD (which those actions all did correctly)
 * says the caller may edit this ticket; it says nothing about whether the person
 * they named works here.
 *
 * Returns the validated member, or null when the field was deliberately left
 * blank — callers can persist `?? null` for the unassigned case and read `.name`
 * for the audit line without a second lookup. Throws {@link ActionRefusal} when
 * an id was submitted that does not belong to an active, non-disabled member of
 * the current tenant, which `asActionResult` turns into a message the user
 * actually sees. `label` names the field in that message ("owner", "agent",
 * "technician").
 */
export async function resolveAssignableUser(
  raw: unknown,
  label: string,
): Promise<TenantActor | null> {
  // Everything except the database is in `resolveAssignment`, which is where a
  // test can execute it. What is left here is the one thing that genuinely needs
  // a server: the TenantMember join. Keeping the composition on the far side of
  // `server-only` meant the rule every caller leans on — a bad id THROWS, it does
  // not come back as null — could only ever be checked by grepping for the word
  // `throw`, and the regression that matters most looks perfectly correct to a
  // grep.
  return resolveAssignment(raw, label, resolveTenantMemberUser);
}

/**
 * The list of users eligible to be an approval assignee / staff selection: active,
 * non-disabled members of the current tenant scope. Via {@link actorScope}: dormant
 * or an explicit `system` scope → all active, non-disabled users; enforcement with
 * no scope or a null non-system scope → empty (fail closed). Replaces an unscoped
 * `user.findMany` in the workflow editor picker + runtime staffMap, so a workflow
 * can neither offer nor persist a cross-tenant or disabled user id.
 */
export async function listTenantStaff(): Promise<TenantActor[]> {
  const s = actorScope();
  if (s.mode === "closed") return [];
  if (s.mode === "tenant") {
    return basePrisma.$queryRaw<TenantActor[]>`
      SELECT u."id", u."name", u."email"
      FROM "TenantMember" m
      JOIN "User" u ON u."id" = m."userId"
      JOIN "Tenant" t ON t."id" = m."tenantId"
      WHERE m."tenantId" = ${s.tenantId} AND t."active" = true AND u."disabledAt" IS NULL
      ORDER BY u."name" ASC`;
  }
  return basePrisma.$queryRaw<TenantActor[]>`
    SELECT "id", "name", "email" FROM "User"
    WHERE "disabledAt" IS NULL
    ORDER BY "name" ASC`;
}

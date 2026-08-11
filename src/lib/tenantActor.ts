import "server-only";
import { Prisma } from "@prisma/client";
import { basePrisma } from "./db";
import { actingScopeClass } from "./actingScope";
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
 * the ACTING workspace, which `asActionResult` turns into a message the user
 * actually sees. `label` names the field in that message ("owner", "agent",
 * "technician").
 *
 * The lookup is {@link resolveActingTenantMemberUser}, NOT the background
 * {@link resolveTenantMemberUser}, and the difference is the whole point. The
 * background resolver classifies with `currentScopeClass`, which maps DORMANT
 * enforcement — the mode every environment runs in today — to `global` and skips
 * the TenantMember join entirely. Wired that way, this contract validated
 * NOTHING: every id on the platform resolved, so the refusal it exists to
 * produce could not fire until enforcement was switched on. A control that only
 * starts working after the flip is not a control.
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
  return resolveAssignment(raw, label, resolveActingTenantMemberUser);
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

/* ------------------------------------------------------------------------- */
/* USER-ORIGINATED variants                                                   */
/*                                                                            */
/* The resolvers above classify with `currentScopeClass`, which maps DORMANT   */
/* enforcement to `global`. That is right for a cron or a webhook and wrong    */
/* for a person sitting in a workspace: while dormant, the membership join is  */
/* skipped entirely, so an assignee is validated against the whole platform    */
/* and a picker lists every user on it. Both only start working when           */
/* enforcement is switched on, which is the opposite of a safety control.      */
/*                                                                            */
/* These variants classify with `actingScopeClass` instead, so the same code   */
/* enforces membership today. They are deliberately SEPARATE rather than a     */
/* change to the originals: background and token paths rely on the existing    */
/* semantics, and there is no session there for an acting scope to resolve.    */
/* ------------------------------------------------------------------------- */

/**
 * {@link resolveTenantMemberUser} for an assignee a SIGNED-IN PERSON picked.
 *
 * Returns null — the caller refuses — when the id is not an active member of the
 * acting workspace. Under enforcement this is identical to the original; while
 * dormant it is the difference between checking membership and not checking it.
 */
export async function resolveActingTenantMemberUser(userId: string): Promise<TenantActor | null> {
  const s = await actingScopeClass();
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
 * {@link listTenantStaff} for a picker a SIGNED-IN PERSON is looking at.
 *
 * A picker fixed without its check is half a fix, and a check that is inert while
 * dormant is the other half missing — so the picker and the assignment check must
 * classify the same way, in BOTH modes. Use this for any staff dropdown rendered
 * to a logged-in user; keep {@link listTenantStaff} for workflow runtime lookups
 * that run without a session.
 */
export async function listActingTenantStaff(): Promise<TenantActor[]> {
  const s = await actingScopeClass();
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

/**
 * Membership of the acting workspace, DISABLED MEMBERS INCLUDED — for the
 * screens and actions that ADMINISTER people rather than assign work to them.
 *
 * Everything above deliberately drops disabled accounts, because you must not
 * hand live work or a live approval token to a suspended login. An administration
 * surface needs the opposite: Settings → Access lists disabled members precisely
 * so an owner can reactivate them, and a "Reactivate" button that cannot find its
 * own target is not a safer button, it is a broken one. So the filter here is
 * membership and nothing else.
 *
 * `null` means "no membership restriction applies" — the `global` branch, reached
 * only with no session at all, which for these screens cannot happen behind
 * `requireOwner`. It is returned rather than a list of every id so a caller cannot
 * mistake "unscoped" for "a workspace that happens to contain everyone". An empty
 * array is the fail-closed answer and is genuinely empty.
 */
export async function actingTenantMemberIds(): Promise<string[] | null> {
  const s = await actingScopeClass();
  if (s.mode === "closed") return [];
  if (s.mode === "global") return null;
  const rows = await basePrisma.$queryRaw<Array<{ userId: string }>>`
    SELECT m."userId"
    FROM "TenantMember" m
    JOIN "Tenant" t ON t."id" = m."tenantId"
    WHERE m."tenantId" = ${s.tenantId} AND t."active" = true`;
  return rows.map((row) => row.userId);
}

/**
 * May the acting workspace administer this person at all?
 *
 * The guard for every action that takes a `userId` off a form and changes that
 * person's account — role, 2FA, disablement, sessions. All of them proved only
 * that the User row existed, which for a GLOBAL table is not a question worth
 * asking: an owner of one workspace could post another workspace's user id and
 * disable them, reset their second factor, or promote them.
 *
 * Built on {@link actingTenantMemberIds} so there is ONE membership rule for the
 * management surfaces rather than a second one that agrees with it today.
 */
export async function isActingTenantMember(userId: string): Promise<boolean> {
  const ids = await actingTenantMemberIds();
  return ids === null || ids.includes(userId);
}

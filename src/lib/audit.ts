import crypto from "crypto";
import { headers } from "next/headers";
import { basePrisma, prisma } from "./db";
import { currentTenantScope } from "./tenantScope";
import { bestEffortAgreedTenantId } from "./compositeTenantRules";

export type AuditEntry = {
  action: string;
  summary: string;
  contactId?: string | null;
  leadId?: string | null;
  user?: { id: string; name: string } | null;
  userName?: string;
  /**
   * Override the derived actor classification. Needed for principals that are NOT
   * CRM users — a PlatformAdmin, for instance, supplies `user` for attribution but
   * its id does not resolve in the `User` table, so recording it as "user" would
   * make the trail lie. Pass e.g. "platform_admin".
   */
  actorType?: string;
  entityType?: string | null;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  changedFields?: string[];
  source?: string;
  metadata?: Record<string, unknown>;
  correlationId?: string | null;
};

const SENSITIVE_KEY = /(password|secret|token|authorization|cookie|otp|totp|backupcode|signature|licen[cs]e|emergencycontact)/i;

function sanitizeAuditValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.map((item) => sanitizeAuditValue(item, depth + 1));
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && value.length > 10_000) return `${value.slice(0, 10_000)}…`;
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitizeAuditValue(nested, depth + 1);
  }
  return output;
}

function changedFields(before: unknown, after: unknown): string[] {
  if (!before || !after || typeof before !== "object" || typeof after !== "object") return [];
  const left = before as Record<string, unknown>;
  const right = after as Record<string, unknown>;
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].filter(
    (key) => JSON.stringify(left[key]) !== JSON.stringify(right[key])
  );
}

async function requestContext() {
  try {
    const requestHeaders = await headers();
    return {
      ipAddress: requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim()
        ?? requestHeaders.get("x-real-ip")
        ?? null,
      userAgent: requestHeaders.get("user-agent")?.slice(0, 500) ?? null,
      correlationId: requestHeaders.get("x-vercel-id") ?? requestHeaders.get("x-request-id") ?? null,
    };
  } catch {
    return { ipAddress: null, userAgent: null, correlationId: null };
  }
}

function actorType(entry: AuditEntry, actorName: string) {
  // An explicit classification always wins — a non-User principal (platform admin)
  // sets `user` for attribution but must not be recorded as a CRM user.
  if (entry.actorType) return entry.actorType;
  if (entry.user) return "user";
  if (/customer|portal/i.test(actorName)) return "customer";
  if (/automation|journey|cron|worker/i.test(actorName)) return "automation";
  return "system";
}

/**
 * Resolve audit ownership without trusting an unrelated staff cookie.
 *
 * - Non-user work (cron, public token, portal, webhook) trusts only an explicit
 *   normal tenant scope. A system scope and a missing/null scope remain global.
 *
 *   REVIEWED against the 2026-08-10 pre-flip audit and DELIBERATELY LEFT ALONE.
 *   The obvious "fix" for the 24 unowned AuditEvent rows is to fall back to the
 *   staff session here, and it would be a mistake in both directions: a public
 *   token page or the portal can be opened in a browser that also holds a CRM
 *   cookie, and that cookie says who is SIGNED IN, not who owns the record — while
 *   the paths that actually lose their tenant (cron, webhook) carry no cookie at
 *   all, so the fallback yields null for them anyway. It would add misattribution
 *   and no attribution. The remaining unowned audit rows are the ones that
 *   genuinely have no owner: platform-admin actions, and work under a `system`
 *   scope. Those are correct as NULL.
 * - Staff-attributed work keeps the stricter actor/session identity check so an
 *   action attributed to another user cannot inherit the cookie user's tenant.
 */
async function actingTenantId(entry: AuditEntry): Promise<string | null> {
  if (!entry.user) {
    const scope = currentTenantScope();
    return scope && !scope.system && scope.tenantId ? scope.tenantId : null;
  }
  try {
    const { getCurrentUser, getActiveTenantId } = await import("./auth");
    const current = await getCurrentUser();
    if (!current || current.id !== entry.user.id) return null;
    return await getActiveTenantId();
  } catch {
    return null;
  }
}

/**
 * The tenant the AuditLog row may actually claim.
 *
 * AuditLog carries COMPOSITE foreign keys:
 *
 *     (tenantId, contactId) → Contact(tenantId, id)
 *     (tenantId, leadId)    → Lead(tenantId, id)
 *
 * so the audit row's tenant must equal the tenant of every record it points at.
 * The ACTING tenant is not automatically that. Tenant stamping is still dormant,
 * so a contact created today is written with `tenantId` NULL while
 * `getActiveTenantId()` resolves to a real id — and the pair
 * `(tenant_denago_cpt, <new contact>)` matches no row in Contact.
 *
 * ── What that cost in production, 2026-08-07 ────────────────────────────────
 *
 * Creating a lead for a NEW person failed with
 * `AuditLog_tenantId_contactId_fkey`, three times in four minutes. The contact
 * and the lead were already committed — the audit write happens afterwards and
 * `logAuditStrict` throws — so each "failure" left a real lead behind and the
 * retry made another. Two duplicate leads for one person, and the delete that
 * was meant to clear one reported failure too. Existing contacts were fine,
 * because a migration had backfilled their tenantId; only a brand-new contact
 * hit it.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * A composite foreign key with a NULL column is not enforced (MATCH SIMPLE), so
 * the audit row is legal when its tenant matches the referenced rows OR when it
 * claims no tenant at all. Referenced records therefore decide:
 *
 *   - nothing referenced       → the acting tenant, as before;
 *   - all references agree     → that tenant;
 *   - anything else            → NULL.
 *
 * The last case gives up tenant attribution on the AuditLog row rather than
 * losing the audit entirely, which is what the 309 pre-existing NULL rows
 * already look like. `AuditEvent` — the append-only stream this pairs with —
 * carries no such key and keeps the full record either way.
 *
 * This is not a workaround for the constraint. An audit row asserting a tenant
 * that the record it describes does not belong to is simply wrong, and the
 * constraint is what noticed.
 */
/**
 * THE CONCESSION IS `AuditLog`'s ALONE, so it is no longer charged to `AuditEvent`.
 *
 * Everything above describes a constraint that exists on ONE of the two tables
 * this module writes. `AuditLog` carries the composite key
 * `(tenantId, contactId)` / `(tenantId, leadId)`; `AuditEvent` carries no foreign
 * key of any kind — not to Lead, not to Contact, not to Tenant. Confirmed against
 * every migration: `AuditEvent` has zero FOREIGN KEY definitions.
 *
 * This used to return one value that both writes shared, so whenever the
 * references disagreed — or `actingTenantId` could not resolve one — the NULL
 * that `AuditLog` needed to stay insertable was also stamped on `AuditEvent`,
 * which nothing was constraining. The comment above already draws the
 * distinction ("`AuditEvent` … carries no such key and keeps the full record
 * either way"); the tenant column was the one part of the record it did not
 * actually keep.
 *
 * That was invisible while every query bypassed RLS. Under enforcement the
 * tenant column decides whether a row EXISTS: `AuditEvent`'s policy is the
 * standard `bypass_rls OR "tenantId" = current_setting(...)`, with no NULL
 * escape hatch, so a null-tenant event is invisible to every workspace
 * including the one that caused it. Production is carrying 24 such rows across
 * Lead, Tenant, SignatureRequest, Contact, TestDriveBooking and quote events —
 * and they are the UNUSUAL operations, the ones where the references disagreed,
 * which is precisely the set an investigation would go looking for.
 *
 * So: `log` keeps the best-effort value the composite key requires, `event`
 * keeps the acting tenant unconditionally. Same audit, same content; the stream
 * simply stops discarding attribution it was never required to discard.
 */
type AuditTenantIds = { event: string | null; log: string | null };

async function auditTenantIds(entry: AuditEntry): Promise<AuditTenantIds> {
  const acting = await actingTenantId(entry);
  if (!entry.leadId && !entry.contactId) return { event: acting, log: acting };

  const [lead, contact] = await Promise.all([
    entry.leadId
      ? basePrisma.lead.findUnique({ where: { id: entry.leadId }, select: { tenantId: true } })
      : Promise.resolve(null),
    entry.contactId
      ? basePrisma.contact.findUnique({ where: { id: entry.contactId }, select: { tenantId: true } })
      : Promise.resolve(null),
  ]);

  // A referenced id that resolves to no row cannot constrain anything, and the
  // insert will fail on its own foreign key — as it should.
  const referenced: Array<string | null> = [];
  if (entry.leadId && lead) referenced.push(lead.tenantId);
  if (entry.contactId && contact) referenced.push(contact.tenantId);

  // BEST-EFFORT, and audit is the ONLY caller entitled to it. If the lead and the
  // contact disagree, this row degrades to a NULL tenant instead of throwing —
  // losing attribution on the log rather than failing the operation the log exists
  // to record. `Communication` and `Activity` use the strict `agreedTenantId()`,
  // which refuses; see compositeTenantRules.ts for why these must stay apart.
  //
  // `event` is NOT degraded: no key constrains it, so there is nothing to concede to.
  return { event: acting, log: bestEffortAgreedTenantId(referenced, acting) };
}

/**
 * Writes both the legacy customer-history record and the professional append-only
 * AuditEvent stream. Use logAuditStrict for permission, role, pipeline, forecast,
 * deletion, export, and other governance-sensitive changes.
 */
/**
 * A caller-supplied transaction the audit should join. When present the audit
 * rows are written on THAT transaction, so the change being audited and its audit
 * record commit or roll back together. Without it the audit opens its own
 * transaction and can therefore fail independently — which for a governance
 * action means the change lands while the operator is told it failed and no trail
 * exists.
 */
/**
 * Structural, so BOTH clients' transactions qualify.
 *
 * Deriving this from `basePrisma.$transaction` alone excluded the SCOPED
 * client's transaction, whose type differs — which meant a caller doing its
 * write through `prisma` (as the CRM actions do, to keep the tenant guard in
 * play) could not hand its transaction to the audit at all, and was pushed back
 * to auditing after the commit. That is the split this parameter exists to
 * close, so the type must not be the thing that reopens it.
 *
 * Only what the audit write actually touches is named here.
 */
type BaseTx = Parameters<Parameters<typeof basePrisma.$transaction>[0]>[0];
type ScopedTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
type AuditTx = BaseTx | ScopedTx;

/**
 * Transaction options for a governance change that carries its audit inside the
 * same transaction.
 *
 * logAuditStrict resolves the request context and the acting tenant before it
 * writes, and that work now counts against the transaction budget. Prisma's
 * default interactive timeout is 5s, which a cold path can exceed — and the
 * failure mode is the exact one this atomicity exists to prevent, only louder:
 * the whole change rolls back and the person is told it failed.
 */
export const GOVERNANCE_TX = { timeout: 20_000, maxWait: 10_000 } as const;

async function writeAudit(entry: AuditEntry, tx?: AuditTx) {
  const context = await requestContext();
  const entityType = entry.entityType ?? (entry.leadId ? "Lead" : entry.contactId ? "Contact" : null);
  const entityId = entry.entityId ?? entry.leadId ?? entry.contactId ?? null;
  const safeBefore = entry.before == null ? null : sanitizeAuditValue(entry.before);
  const safeAfter = entry.after == null ? null : sanitizeAuditValue(entry.after);
  const safeMetadata = entry.metadata == null
    ? null
    : sanitizeAuditValue(entry.metadata) as Record<string, unknown>;
  const fields = entry.changedFields ?? changedFields(safeBefore, safeAfter);
  const actorName = entry.userName ?? entry.user?.name ?? "System";
  // Two values, not one: only `log` may be degraded to NULL, and only because
  // AuditLog's composite key demands it. See auditTenantIds.
  const tenantIds = await auditTenantIds(entry);

  const write = async (candidate: AuditTx) => {
    // Both clients' transactions expose the same `$executeRaw` and
    // `auditLog.create`; only the generic wrappers Prisma puts around them
    // differ, and a union of those wrappers is not callable. One narrowing here
    // keeps the two call sites honest rather than pushing the difference back
    // out to every caller.
    const transaction = candidate as BaseTx;
    await transaction.$executeRaw`
      INSERT INTO "AuditEvent" (
        "id", "tenantId", "actorUserId", "actorName", "actorType", "eventType", "entityType", "entityId",
        "summary", "beforeJson", "afterJson", "changedFieldsJson", "source", "ipAddress",
        "userAgent", "correlationId", "metadata"
      ) VALUES (
        ${crypto.randomUUID()}, ${tenantIds.event}, ${entry.user?.id ?? null}, ${actorName}, ${actorType(entry, actorName)},
        ${entry.action}, ${entityType}, ${entityId}, ${entry.summary},
        ${safeBefore == null ? null : JSON.stringify(safeBefore)}::jsonb,
        ${safeAfter == null ? null : JSON.stringify(safeAfter)}::jsonb,
        ${JSON.stringify(fields)}::jsonb, ${entry.source ?? "app"}, ${context.ipAddress},
        ${context.userAgent}, ${entry.correlationId ?? context.correlationId},
        ${safeMetadata == null ? null : JSON.stringify(safeMetadata)}::jsonb
      )
    `;

    await transaction.auditLog.create({
      data: {
        action: entry.action,
        summary: entry.summary,
        contactId: entry.contactId ?? null,
        leadId: entry.leadId ?? null,
        userId: entry.user?.id ?? null,
        userName: actorName,
        tenantId: tenantIds.log,
      },
    });
  };

  // Join the caller's transaction when given one, so the audited change and its
  // audit row share a fate. Otherwise open our own.
  if (tx) await write(tx);
  else await basePrisma.$transaction(write);
}

export async function logAudit(entry: AuditEntry): Promise<void> {
  try {
    await writeAudit(entry);
  } catch {
    // Existing non-governance callers remain best-effort and keep their legacy timeline.
    try {
      await prisma.auditLog.create({
        data: {
          action: entry.action,
          summary: entry.summary,
          contactId: entry.contactId ?? null,
          leadId: entry.leadId ?? null,
          userId: entry.user?.id ?? null,
          userName: entry.userName ?? entry.user?.name ?? "System",
          // The `log` value, NOT the acting tenant. This is the retry after writeAudit
          // failed, and the likeliest reason it failed is the composite foreign key
          // — the acting tenant did not match the referenced contact or lead. Retrying
          // with the value that caused the failure guarantees the retry fails too, so
          // the fallback that exists to save the timeline entry threw it away instead.
          // (This row is an AuditLog, so it is the constrained side; `event` would be
          // wrong here for the same reason `log` is right.)
          tenantId: (await auditTenantIds(entry)).log,
        },
      });
    } catch {}
  }
}

/**
 * Governance-sensitive audit. Throws on failure — the caller is expected to treat
 * an unwritable audit trail as a failed operation.
 *
 * Pass `tx` to write the audit ON the caller's transaction, so the change and its
 * audit record commit together. Without it the audit commits separately, which
 * means a failing audit leaves the change in place while the caller reports
 * failure — for something like a password reset, the operator would be told it did
 * not happen when it did.
 */
export async function logAuditStrict(entry: AuditEntry, tx?: AuditTx): Promise<void> {
  await writeAudit(entry, tx);
}

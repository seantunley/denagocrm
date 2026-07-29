import crypto from "crypto";
import { headers } from "next/headers";
import { basePrisma, prisma } from "./db";
import { currentTenantScope } from "./tenantScope";

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
type AuditTx = Parameters<Parameters<typeof basePrisma.$transaction>[0]>[0];

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
  const tenantId = await actingTenantId(entry);

  const write = async (transaction: AuditTx) => {
    await transaction.$executeRaw`
      INSERT INTO "AuditEvent" (
        "id", "tenantId", "actorUserId", "actorName", "actorType", "eventType", "entityType", "entityId",
        "summary", "beforeJson", "afterJson", "changedFieldsJson", "source", "ipAddress",
        "userAgent", "correlationId", "metadata"
      ) VALUES (
        ${crypto.randomUUID()}, ${tenantId}, ${entry.user?.id ?? null}, ${actorName}, ${actorType(entry, actorName)},
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
        tenantId,
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
          tenantId: await actingTenantId(entry),
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

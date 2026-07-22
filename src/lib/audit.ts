import crypto from "crypto";
import { headers } from "next/headers";
import { basePrisma, prisma } from "./db";

export type AuditEntry = {
  action: string;
  summary: string;
  contactId?: string | null;
  leadId?: string | null;
  user?: { id: string; name: string } | null;
  userName?: string;
  entityType?: string | null;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  changedFields?: string[];
  source?: string;
  metadata?: Record<string, unknown>;
  correlationId?: string | null;
};

const SENSITIVE_KEY = /(password|secret|token|authorization|cookie|otp|totp|backupcode|signature)/i;

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
  if (entry.user) return "user";
  if (/customer|portal/i.test(actorName)) return "customer";
  if (/automation|journey|cron|worker/i.test(actorName)) return "automation";
  return "system";
}

/**
 * The acting tenant for an audit entry, best-effort. Only read for a real
 * authenticated STAFF actor (`entry.user` present): customer/portal/website and
 * system/cron entries must stay null, even if the request happens to carry a
 * same-origin staff `denago_session` cookie — otherwise their attribution would
 * be corrupted by an unrelated tenant. Dynamically imported to avoid an import
 * cycle with auth, and fully guarded (no session/request → null, never throws).
 *
 * The session tenant is trusted ONLY when the current authenticated cookie user
 * IS the entry's actor. Otherwise — an owner logging an action attributed to
 * another user, or an actor set programmatically while a different staff cookie
 * rides along — the cookie user's tenant would be mis-stamped onto someone else's
 * event. When the actor and the session differ, we leave the tenant null rather
 * than attribute it to the wrong tenant.
 */
async function actingTenantId(entry: AuditEntry): Promise<string | null> {
  if (!entry.user) return null; // non-staff / system actor → no session tenant
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
async function writeAudit(entry: AuditEntry) {
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

  await basePrisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`
      INSERT INTO "AuditEvent" (
        "id", "actorUserId", "actorName", "actorType", "eventType", "entityType", "entityId",
        "summary", "beforeJson", "afterJson", "changedFieldsJson", "source", "ipAddress",
        "userAgent", "correlationId", "metadata"
      ) VALUES (
        ${crypto.randomUUID()}, ${entry.user?.id ?? null}, ${actorName}, ${actorType(entry, actorName)},
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
  });
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

export async function logAuditStrict(entry: AuditEntry): Promise<void> {
  await writeAudit(entry);
}

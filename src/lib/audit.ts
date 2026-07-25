import crypto from "crypto";
import { headers } from "next/headers";
import { basePrisma, prisma } from "./db";
import { currentTenantScope } from "./tenantScope";
import { enqueueAutomationFromAudit } from "./automationEventBridge";

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
  if (entry.user) return "user";
  if (/customer|portal/i.test(actorName)) return "customer";
  if (/automation|journey|cron|worker/i.test(actorName)) return "automation";
  return "system";
}

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
 * AuditEvent stream. Mapped business lifecycle events are queued for the Journey
 * engine in the SAME transaction, so an audited change cannot lose its automation.
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
  const auditEventId = crypto.randomUUID();

  await basePrisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`
      INSERT INTO "AuditEvent" (
        "id", "actorUserId", "actorName", "actorType", "eventType", "entityType", "entityId",
        "summary", "beforeJson", "afterJson", "changedFieldsJson", "source", "ipAddress",
        "userAgent", "correlationId", "metadata"
      ) VALUES (
        ${auditEventId}, ${entry.user?.id ?? null}, ${actorName}, ${actorType(entry, actorName)},
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

  // Fan out automation triggers AFTER the audit has committed, and best-effort.
  // Keeping this out of the audit transaction means a malformed payload or a
  // failed enrichment query can never roll back the governance record (writeAudit
  // is also the strict path, which re-throws), and its extra quote/jobCard reads
  // no longer hold the audit transaction open. A lost trigger is recoverable; a
  // lost audit is not.
  try {
    await enqueueAutomationFromAudit(basePrisma, {
      auditEventId,
      tenantId,
      action: entry.action,
      summary: entry.summary,
      entityType,
      entityId,
      leadId: entry.leadId ?? null,
      contactId: entry.contactId ?? null,
      before: safeBefore,
      after: safeAfter,
      metadata: safeMetadata,
    });
  } catch (error) {
    console.error("automation bridge: enqueue from audit failed", error);
  }
}

export async function logAudit(entry: AuditEntry): Promise<void> {
  try {
    await writeAudit(entry);
  } catch {
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

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

function changedFields(before: unknown, after: unknown): string[] {
  if (!before || !after || typeof before !== "object" || typeof after !== "object") return [];
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (key) => JSON.stringify(a[key]) !== JSON.stringify(b[key])
  );
}

async function requestContext() {
  try {
    const h = await headers();
    return {
      ipAddress: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? null,
      userAgent: h.get("user-agent")?.slice(0, 500) ?? null,
      correlationId: h.get("x-vercel-id") ?? h.get("x-request-id") ?? null,
    };
  } catch {
    return { ipAddress: null, userAgent: null, correlationId: null };
  }
}

/**
 * Writes both the legacy customer-history record and the professional append-only
 * AuditEvent stream. AuditEvent failures are surfaced for security-sensitive
 * callers through logAuditStrict; legacy callers remain best-effort.
 */
async function writeAudit(entry: AuditEntry) {
  const context = await requestContext();
  const entityType = entry.entityType ?? (entry.leadId ? "Lead" : entry.contactId ? "Contact" : null);
  const entityId = entry.entityId ?? entry.leadId ?? entry.contactId ?? null;
  const fields = entry.changedFields ?? changedFields(entry.before, entry.after);
  const actorName = entry.userName ?? entry.user?.name ?? "System";

  await basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO "AuditEvent" (
        "id", "actorUserId", "actorName", "actorType", "eventType", "entityType", "entityId",
        "summary", "beforeJson", "afterJson", "changedFieldsJson", "source", "ipAddress",
        "userAgent", "correlationId", "metadata"
      ) VALUES (
        ${crypto.randomUUID()}, ${entry.user?.id ?? null}, ${actorName},
        ${entry.user ? "user" : actorName === "Automation" ? "automation" : "system"},
        ${entry.action}, ${entityType}, ${entityId}, ${entry.summary},
        ${entry.before == null ? null : JSON.stringify(entry.before)}::jsonb,
        ${entry.after == null ? null : JSON.stringify(entry.after)}::jsonb,
        ${JSON.stringify(fields)}::jsonb, ${entry.source ?? "app"}, ${context.ipAddress},
        ${context.userAgent}, ${entry.correlationId ?? context.correlationId},
        ${entry.metadata == null ? null : JSON.stringify(entry.metadata)}::jsonb
      )
    `;

    // Keep the existing contact/lead timeline populated during migration.
    await tx.auditLog.create({
      data: {
        action: entry.action,
        summary: entry.summary,
        contactId: entry.contactId ?? null,
        leadId: entry.leadId ?? null,
        userId: entry.user?.id ?? null,
        userName: actorName,
      },
    });
  });
}

export async function logAudit(entry: AuditEntry): Promise<void> {
  try {
    await writeAudit(entry);
  } catch {
    // Compatibility behaviour for existing callers. Security-sensitive actions
    // should use logAuditStrict so a missing audit event fails the operation.
    try {
      await prisma.auditLog.create({
        data: {
          action: entry.action,
          summary: entry.summary,
          contactId: entry.contactId ?? null,
          leadId: entry.leadId ?? null,
          userId: entry.user?.id ?? null,
          userName: entry.userName ?? entry.user?.name ?? "System",
        },
      });
    } catch {}
  }
}

export async function logAuditStrict(entry: AuditEntry): Promise<void> {
  await writeAudit(entry);
}

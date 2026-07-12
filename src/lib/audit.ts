import { prisma } from "./db";

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
  metadata?: Record<string, unknown>;
};

/**
 * Writes a customer history entry. Never throws — auditing must not break
 * the action being audited. Rich entity metadata is accepted so callers are
 * forward-compatible with the append-only AuditEvent upgrade.
 */
export async function logAudit(entry: AuditEntry): Promise<void> {
  try {
    const context = [
      entry.entityType && entry.entityId ? `${entry.entityType}:${entry.entityId}` : null,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
    ].filter(Boolean).join(" · ");
    await prisma.auditLog.create({
      data: {
        action: entry.action,
        summary: context ? `${entry.summary} [${context}]` : entry.summary,
        contactId: entry.contactId ?? null,
        leadId: entry.leadId ?? null,
        userId: entry.user?.id ?? null,
        userName: entry.userName ?? entry.user?.name ?? "System",
      },
    });
  } catch {
    // Existing audit history remains best-effort on this branch.
  }
}

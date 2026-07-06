import { prisma } from "./db";

/**
 * Writes a customer history entry. Never throws — auditing must not break
 * the action being audited.
 */
export async function logAudit(entry: {
  action: string;
  summary: string;
  contactId?: string | null;
  leadId?: string | null;
  user?: { id: string; name: string } | null; // null/undefined = System
  userName?: string; // override, e.g. "Automation"
}): Promise<void> {
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
  } catch {
    // ignore — history is best-effort
  }
}

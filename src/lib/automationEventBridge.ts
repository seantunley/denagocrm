import crypto from "crypto";
import type { Prisma } from "@prisma/client";
import { automationTriggerForAudit } from "./automationAuditMap";
import { hashJourneyKey } from "./journeyEngineShared";
import type { JourneyEntityType } from "./journeyContext";

export type AutomationAuditEvent = {
  auditEventId: string;
  tenantId: string | null;
  action: string;
  summary: string;
  entityType: string | null;
  entityId: string | null;
  leadId: string | null;
  contactId: string | null;
  before: unknown;
  after: unknown;
  metadata: Record<string, unknown> | null;
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function entity(event: AutomationAuditEvent): { entityType: JourneyEntityType; entityId: string } {
  if (event.leadId) return { entityType: "lead", entityId: event.leadId };
  if (event.contactId) return { entityType: "contact", entityId: event.contactId };
  return { entityType: "system", entityId: event.entityId ?? event.auditEventId };
}

function inferredStage(event: AutomationAuditEvent, after: Record<string, unknown>) {
  if (after.stage ?? after.stageKey ?? after.status) return after.stage ?? after.stageKey ?? after.status;
  if (event.action.toLowerCase() === "jobcard.stage") {
    const match = event.summary.match(/→\s*(.+)$/);
    return match?.[1]?.trim() ?? null;
  }
  return null;
}

export async function enqueueAutomationFromAudit(
  transaction: Prisma.TransactionClient,
  event: AutomationAuditEvent,
): Promise<void> {
  const trigger = automationTriggerForAudit(event);
  if (!trigger) return;
  const target = entity(event);
  const after = object(event.after);
  const before = object(event.before);
  const metadata = event.metadata ?? {};
  const sourceId = event.entityId ?? target.entityId;
  const payload = {
    summary: event.summary,
    status: after.status ?? metadata.status ?? null,
    stage: inferredStage(event, after) ?? metadata.stage ?? null,
    previousStage: before.stage ?? before.stageKey ?? before.status ?? null,
    priority: after.priority ?? metadata.priority ?? null,
    branch: after.branch ?? after.location ?? metadata.branch ?? null,
    outcome: after.salesOutcome ?? metadata.outcome ?? null,
    source: {
      id: sourceId,
      entityType: event.entityType,
      ...metadata,
      before,
      after,
    },
  };

  await transaction.journeyEvent.create({
    data: {
      id: `je_${crypto.randomUUID()}`,
      tenantId: event.tenantId,
      type: trigger,
      entityType: target.entityType,
      entityId: target.entityId,
      payload: payload as Prisma.InputJsonValue,
      dedupeKey: hashJourneyKey(`audit:${event.auditEventId}:${trigger}`),
    },
  });
}

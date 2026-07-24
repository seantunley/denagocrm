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

async function enrichedSource(
  transaction: Prisma.TransactionClient,
  trigger: string,
  event: AutomationAuditEvent,
  metadata: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (trigger.startsWith("quote_") || trigger === "delivery_scheduled") {
    const numberMatch = event.summary.match(/Q-(\d+)/i);
    if (numberMatch) {
      const quote = await transaction.quote.findUnique({
        where: { number: Number(numberMatch[1]) },
        select: { id: true, number: true, status: true, leadId: true, contactId: true, validUntil: true, deliveryScheduledFor: true },
      });
      if (quote) return {
        id: quote.id,
        entityType: "Quote",
        quoteId: quote.id,
        reference: `Q-${quote.number}`,
        status: quote.status,
        leadId: quote.leadId,
        contactId: quote.contactId,
        validUntil: quote.validUntil?.toISOString() ?? null,
        deliveryScheduledFor: quote.deliveryScheduledFor?.toISOString() ?? null,
        ...metadata,
      };
    }
  }

  if (trigger.startsWith("job_")) {
    const numberMatch = event.summary.match(/#(\d+)/);
    if (numberMatch) {
      const job = await transaction.jobCard.findUnique({
        where: { number: Number(numberMatch[1]) },
        select: { id: true, number: true, status: true, vehicleId: true, contactId: true, technicianId: true },
      });
      if (job) return {
        id: job.id,
        entityType: "JobCard",
        jobCardId: job.id,
        reference: `#${job.number}`,
        status: job.status,
        vehicleId: job.vehicleId,
        contactId: job.contactId,
        technicianId: job.technicianId,
        ...metadata,
      };
    }
  }

  return {
    id: event.entityId ?? event.leadId ?? event.contactId ?? event.auditEventId,
    entityType: event.entityType,
    ...metadata,
  };
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
  const source = await enrichedSource(transaction, trigger, event, metadata);
  const payload = {
    summary: event.summary,
    status: after.status ?? source.status ?? metadata.status ?? null,
    stage: inferredStage(event, after) ?? metadata.stage ?? null,
    previousStage: before.stage ?? before.stageKey ?? before.status ?? null,
    priority: after.priority ?? metadata.priority ?? null,
    branch: after.branch ?? after.location ?? metadata.branch ?? null,
    outcome: after.salesOutcome ?? metadata.outcome ?? null,
    source: { ...source, before, after },
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

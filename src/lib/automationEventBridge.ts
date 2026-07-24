import crypto from "crypto";
import type { Prisma } from "@prisma/client";
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

export function automationTriggerForAudit(event: AutomationAuditEvent): string | null {
  const after = object(event.after);
  const action = event.action.toLowerCase();

  if (["test_drive.created", "testdrive.created"].includes(action)) return "test_drive_booked";
  if (["test_drive.completed", "testdrive.completed"].includes(action)) return "test_drive_completed";
  if (["test_drive.no_show", "testdrive.no_show"].includes(action)) return "test_drive_no_show";

  if (["quote.sent", "quote.sign_link_created", "quote.signing_sent"].includes(action)) return "quote_sent";
  if (["quote.opened", "quote.viewed"].includes(action)) return "quote_opened";

  if (["delivery.scheduled", "quote.delivery_scheduled", "fulfilment.delivery_scheduled"].includes(action)) return "delivery_scheduled";

  if (["jobcard.opened", "jobcard.created"].includes(action)) return "job_card_created";
  if (["jobcard.stage_changed", "jobcard.status_changed"].includes(action)) return "job_stage_changed";
  if (["jobcard.completed", "jobcard.closed"].includes(action)) return "job_card_completed";

  if (["warranty.claim_created", "warranty.claim_opened", "warranty_claim.created"].includes(action)) return "warranty_claim_opened";
  if (["recall.created", "recall.issued", "service_bulletin.issued"].includes(action)) return "recall_issued";

  if (action === "case.created") return "case_created";
  if (["case.escalated", "case.sla_escalated"].includes(action)) return "case_escalated";
  if (action === "case.status_changed" && ["closed", "resolved"].includes(String(after.status ?? ""))) return "case_closed";

  if (action.startsWith("portal.request") || ["portal.profile_change_requested", "portal.service_requested", "portal.warranty_requested"].includes(action)) {
    return "portal_request_received";
  }

  if (["document.approved", "document_approval.approved", "workflow.approved"].includes(action)) return "document_approved";
  if (["xero.invoice_status_changed", "xero.invoice.status_changed"].includes(action)) return "xero_invoice_status_changed";

  return null;
}

function entity(event: AutomationAuditEvent): { entityType: JourneyEntityType; entityId: string } {
  if (event.leadId) return { entityType: "lead", entityId: event.leadId };
  if (event.contactId) return { entityType: "contact", entityId: event.contactId };
  return { entityType: "system", entityId: event.entityId ?? event.auditEventId };
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
    stage: after.stage ?? after.stageKey ?? after.status ?? metadata.stage ?? null,
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

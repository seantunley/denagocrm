export type AutomationAuditShape = {
  action: string;
  after?: unknown;
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Pure, side-effect-free lifecycle map kept separate for contract tests. */
export function automationTriggerForAudit(event: AutomationAuditShape): string | null {
  const after = object(event.after);
  const action = event.action.toLowerCase();

  if (["test_drive.created", "testdrive.created"].includes(action)) return "test_drive_booked";
  if (["test_drive.completed", "testdrive.completed"].includes(action)) return "test_drive_completed";
  if (["test_drive.no_show", "testdrive.no_show"].includes(action)) return "test_drive_no_show";

  if (["quote.sent", "quote.sign_link_created", "quote.signing_sent"].includes(action)) return "quote_sent";
  if (["quote.opened", "quote.viewed"].includes(action)) return "quote_opened";
  if (["delivery.scheduled", "quote.delivery_scheduled", "fulfilment.delivery_scheduled"].includes(action)) return "delivery_scheduled";

  if (["jobcard.opened", "jobcard.created"].includes(action)) return "job_card_created";
  if (["jobcard.stage", "jobcard.stage_changed", "jobcard.status_changed"].includes(action)) return "job_stage_changed";
  if (["jobcard.completed", "jobcard.closed"].includes(action)) return "job_card_completed";

  if (["warranty.claim_created", "warranty.claim.opened", "warranty.claim_opened", "warranty_claim.created"].includes(action)) return "warranty_claim_opened";
  if (["recall.created", "recall.issued", "service_bulletin.issued"].includes(action)) return "recall_issued";

  if (["case.created", "portal.case_created"].includes(action)) return "case_created";
  if (["case.escalated", "case.sla_escalated"].includes(action)) return "case_escalated";
  if (action === "case.status_changed" && ["closed", "resolved"].includes(String(after.status ?? ""))) return "case_closed";

  if ([
    "portal.service_request",
    "portal.case_created",
    "portal.warranty_claim_created",
    "portal.profile_change_requested",
    "portal.service_requested",
    "portal.warranty_requested",
  ].includes(action) || action.startsWith("portal.request")) return "portal_request_received";

  if (["document.approved", "document_approval.approved", "workflow.approved", "studio.document.approved"].includes(action)) return "document_approved";
  if (["xero.invoice_status_changed", "xero.invoice.status_changed"].includes(action)) return "xero_invoice_status_changed";
  return null;
}

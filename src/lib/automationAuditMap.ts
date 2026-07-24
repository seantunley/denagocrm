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
export function automationTriggersForAudit(event: AutomationAuditShape): string[] {
  const after = object(event.after);
  const action = event.action.toLowerCase();
  const triggers = new Set<string>();

  if (["test_drive.created", "testdrive.created"].includes(action)) triggers.add("test_drive_booked");
  if (["test_drive.completed", "testdrive.completed"].includes(action)) triggers.add("test_drive_completed");
  if (["test_drive.no_show", "testdrive.no_show"].includes(action)) triggers.add("test_drive_no_show");

  if (["quote.sent", "quote.sign_link_created", "quote.signing_sent"].includes(action)) triggers.add("quote_sent");
  if (["quote.opened", "quote.viewed"].includes(action)) triggers.add("quote_opened");
  if (["delivery.scheduled", "quote.delivery_scheduled", "fulfilment.delivery_scheduled"].includes(action)) triggers.add("delivery_scheduled");

  if (["jobcard.opened", "jobcard.created"].includes(action)) triggers.add("job_card_created");
  if (["jobcard.stage", "jobcard.stage_changed", "jobcard.status_changed"].includes(action)) triggers.add("job_stage_changed");
  if (["jobcard.completed", "jobcard.closed"].includes(action)) triggers.add("job_card_completed");

  if (["warranty.claim_created", "warranty.claim.opened", "warranty.claim_opened", "warranty_claim.created", "portal.warranty_claim_created"].includes(action)) triggers.add("warranty_claim_opened");
  if (["recall.created", "recall.issued", "service_bulletin.issued"].includes(action)) triggers.add("recall_issued");

  if (["case.created", "portal.case_created"].includes(action)) triggers.add("case_created");
  if (["case.escalated", "case.sla_escalated"].includes(action)) triggers.add("case_escalated");
  if (action === "case.status_changed" && ["closed", "resolved"].includes(String(after.status ?? ""))) triggers.add("case_closed");

  if ([
    "portal.service_request",
    "portal.case_created",
    "portal.warranty_claim_created",
    "portal.profile_change_requested",
    "portal.service_requested",
    "portal.warranty_requested",
  ].includes(action) || action.startsWith("portal.request")) triggers.add("portal_request_received");

  if (["document.approved", "document_approval.approved", "workflow.approved", "studio.document.approved"].includes(action)) triggers.add("document_approved");
  if (["xero.invoice_status_changed", "xero.invoice.status_changed"].includes(action)) triggers.add("xero_invoice_status_changed");
  return [...triggers];
}

/** Compatibility helper for callers that expect one primary trigger. */
export function automationTriggerForAudit(event: AutomationAuditShape): string | null {
  return automationTriggersForAudit(event)[0] ?? null;
}

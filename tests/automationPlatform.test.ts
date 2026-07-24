import assert from "node:assert/strict";
import test from "node:test";
import { AUTOMATION_ACTIONS, AUTOMATION_TRIGGERS } from "../src/lib/automationCatalog";
import { automationTriggerForAudit } from "../src/lib/automationAuditMap";
import { parseConditionGroup, parseJourneyDefinition } from "../src/lib/journeyTypes";

const requestedTriggers = [
  "activity_overdue",
  "test_drive_booked",
  "test_drive_completed",
  "test_drive_no_show",
  "quote_sent",
  "quote_opened",
  "quote_expiring",
  "stock_received",
  "stock_inspection_failed",
  "pdi_passed",
  "pdi_failed",
  "delivery_scheduled",
  "delivery_delayed",
  "job_card_created",
  "job_stage_changed",
  "job_card_completed",
  "service_due",
  "warranty_expiring",
  "warranty_claim_opened",
  "recall_issued",
  "case_created",
  "case_escalated",
  "case_overdue",
  "case_closed",
  "portal_request_received",
  "document_approved",
  "signature_request_stalled",
  "xero_invoice_status_changed",
];

const requestedActions = [
  "send_whatsapp",
  "create_case",
  "create_job_card",
  "create_workshop_booking",
  "create_signing_request",
  "request_internal_approval",
  "update_field",
  "assign_branch",
  "assign_team",
  "generate_document",
  "call_webhook",
  "create_xero_draft_invoice",
  "send_portal_notification",
  "escalate_to_manager",
  "create_stock_transfer",
  "create_test_drive_follow_up",
  "set_portal_access",
];

test("the automation catalogue contains every requested trigger and action", () => {
  const triggers = new Set(AUTOMATION_TRIGGERS.map((item) => item.value));
  const actions = new Set(AUTOMATION_ACTIONS.map((item) => item.value));
  assert.deepEqual(requestedTriggers.filter((value) => !triggers.has(value as never)), []);
  assert.deepEqual(requestedActions.filter((value) => !actions.has(value as never)), []);
});

test("current audited business actions map to their cross-module triggers", () => {
  const cases: Array<[string, unknown, string]> = [
    ["test_drive.created", {}, "test_drive_booked"],
    ["test_drive.completed", {}, "test_drive_completed"],
    ["test_drive.no_show", {}, "test_drive_no_show"],
    ["quote.sent", {}, "quote_sent"],
    ["jobcard.opened", {}, "job_card_created"],
    ["jobcard.stage", {}, "job_stage_changed"],
    ["jobcard.completed", {}, "job_card_completed"],
    ["warranty.claim.opened", {}, "warranty_claim_opened"],
    ["recall.created", {}, "recall_issued"],
    ["case.created", {}, "case_created"],
    ["case.status_changed", { status: "closed" }, "case_closed"],
    ["portal.service_request", {}, "portal_request_received"],
    ["portal.warranty_claim_created", {}, "portal_request_received"],
    ["portal.profile_change_requested", {}, "portal_request_received"],
    ["document.approved", {}, "document_approved"],
    ["xero.invoice_status_changed", {}, "xero_invoice_status_changed"],
  ];
  for (const [action, after, expected] of cases) {
    assert.equal(automationTriggerForAudit({ action, after }), expected, action);
  }
  assert.equal(automationTriggerForAudit({ action: "case.status_changed", after: { status: "open" } }), null);
});

test("journey definitions accept new platform actions and dynamic event conditions", () => {
  const conditions = parseConditionGroup({
    logic: "and",
    conditions: [
      { field: "event.priority", operator: "equals", value: "urgent" },
      { field: "source.model", operator: "contains", value: "Rover" },
    ],
  });
  assert.ok(conditions);

  const definition = parseJourneyDefinition({
    startStepId: "wa",
    steps: [
      { id: "wa", type: "send_whatsapp", nextStepId: "case", config: { message: "Hello {{first_name}}" } },
      { id: "case", type: "create_case", nextStepId: null, config: { subject: "Follow-up" } },
    ],
  });
  assert.equal(definition.steps.length, 2);
});

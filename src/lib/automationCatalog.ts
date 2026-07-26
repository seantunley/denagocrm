export const AUTOMATION_TRIGGERS = [
  { value: "lead_created", label: "New lead created", group: "CRM", mode: "event" },
  { value: "stage_entered", label: "Lead enters a stage", group: "CRM", mode: "event" },
  { value: "lead_idle", label: "Lead becomes idle", group: "CRM", mode: "scheduled" },
  { value: "lead_won", label: "Lead is won", group: "CRM", mode: "event" },
  { value: "lead_lost", label: "Lead is lost", group: "CRM", mode: "event" },
  { value: "activity_overdue", label: "Activity becomes overdue", group: "CRM", mode: "scheduled" },

  { value: "test_drive_booked", label: "Test drive booked", group: "Test drives", mode: "event" },
  { value: "test_drive_completed", label: "Test drive completed", group: "Test drives", mode: "event" },
  { value: "test_drive_no_show", label: "Test drive marked no-show", group: "Test drives", mode: "event" },

  { value: "quote_sent", label: "Quote sent", group: "Quotes", mode: "event" },
  { value: "quote_opened", label: "Quote opened", group: "Quotes", mode: "event" },
  { value: "quote_expiring", label: "Quote approaching expiry", group: "Quotes", mode: "scheduled" },
  { value: "quote_signed", label: "Quote signed", group: "Quotes", mode: "event" },
  { value: "quote_declined", label: "Quote declined", group: "Quotes", mode: "event" },

  { value: "stock_received", label: "Stock received", group: "Stock", mode: "event" },
  { value: "stock_inspection_failed", label: "Stock inspection failed", group: "Stock", mode: "event" },
  { value: "pdi_passed", label: "PDI passed", group: "Stock", mode: "event" },
  { value: "pdi_failed", label: "PDI failed", group: "Stock", mode: "event" },

  { value: "delivery_scheduled", label: "Delivery scheduled", group: "Delivery", mode: "event" },
  { value: "delivery_delayed", label: "Delivery delayed", group: "Delivery", mode: "scheduled" },
  { value: "delivered", label: "Vehicle delivered", group: "Delivery", mode: "event" },

  { value: "job_card_created", label: "Job card created", group: "Workshop", mode: "event" },
  { value: "job_stage_changed", label: "Job-card stage changed", group: "Workshop", mode: "event" },
  { value: "job_card_completed", label: "Job card completed", group: "Workshop", mode: "event" },
  { value: "service_due", label: "Vehicle service due", group: "Workshop", mode: "scheduled" },

  { value: "warranty_expiring", label: "Warranty approaching expiry", group: "Warranty", mode: "scheduled" },
  { value: "warranty_claim_opened", label: "Warranty claim opened", group: "Warranty", mode: "event" },
  { value: "recall_issued", label: "Recall issued", group: "Warranty", mode: "event" },

  { value: "case_created", label: "Support case created", group: "Support", mode: "event" },
  { value: "case_escalated", label: "Support case escalated", group: "Support", mode: "event" },
  { value: "case_overdue", label: "Support case overdue", group: "Support", mode: "scheduled" },
  { value: "case_closed", label: "Support case closed", group: "Support", mode: "event" },

  { value: "portal_request_received", label: "Portal request received", group: "Portal", mode: "event" },
  { value: "document_approved", label: "Document approved", group: "Documents", mode: "event" },
  { value: "signature_request_stalled", label: "Signature request stalled", group: "Documents", mode: "scheduled" },
  { value: "xero_invoice_status_changed", label: "Xero invoice status changed", group: "Xero", mode: "event" },

  { value: "referral_earned", label: "Referral earned", group: "Marketing", mode: "event" },
  { value: "contact_segment", label: "Contact joins a segment", group: "Marketing", mode: "scheduled" },
  { value: "purchase_anniversary", label: "Purchase anniversary", group: "Marketing", mode: "scheduled" },
  { value: "win_back", label: "Inactive customer win-back", group: "Marketing", mode: "scheduled" },
] as const;

export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number]["value"];

export const AUTOMATION_ACTIONS = [
  { value: "send_email", label: "Send email", group: "Messages" },
  { value: "send_sms", label: "Send SMS", group: "Messages" },
  { value: "send_whatsapp", label: "Send WhatsApp", group: "Messages" },
  { value: "send_push", label: "Notify the team", group: "Messages" },
  { value: "send_portal_notification", label: "Send portal notification", group: "Messages" },

  { value: "create_activity", label: "Create activity", group: "CRM" },
  { value: "create_case", label: "Create support case", group: "CRM" },
  { value: "update_field", label: "Update a field", group: "CRM" },
  { value: "move_stage", label: "Move lead stage", group: "CRM" },
  { value: "assign_user", label: "Assign lead", group: "CRM" },
  { value: "assign_branch", label: "Assign branch", group: "CRM" },
  { value: "assign_team", label: "Assign team", group: "CRM" },
  { value: "add_tag", label: "Add contact tag", group: "CRM" },
  { value: "remove_tag", label: "Remove contact tag", group: "CRM" },
  { value: "escalate_to_manager", label: "Escalate to manager", group: "CRM" },

  { value: "create_job_card", label: "Create job card", group: "Workshop" },
  { value: "create_workshop_booking", label: "Create workshop booking", group: "Workshop" },
  { value: "create_stock_transfer", label: "Create stock transfer", group: "Stock" },
  { value: "create_test_drive_follow_up", label: "Create test-drive follow-up", group: "Test drives" },

  { value: "generate_document", label: "Generate document", group: "Documents" },
  { value: "create_signing_request", label: "Create signing request", group: "Documents" },
  { value: "request_internal_approval", label: "Request internal approval", group: "Documents" },

  { value: "set_portal_access", label: "Add or remove portal access", group: "Portal" },
  { value: "call_webhook", label: "Call webhook", group: "Integrations" },
  { value: "create_xero_draft_invoice", label: "Create Xero draft invoice", group: "Integrations" },

  { value: "wait", label: "Wait", group: "Flow" },
  { value: "condition", label: "Condition / branch", group: "Flow" },
  { value: "stop", label: "Stop journey", group: "Flow" },
] as const;

export type AutomationAction = (typeof AUTOMATION_ACTIONS)[number]["value"];

export const SCHEDULED_AUTOMATION_TRIGGERS = new Set<AutomationTrigger>(
  AUTOMATION_TRIGGERS.filter((trigger) => trigger.mode === "scheduled").map((trigger) => trigger.value),
);

export function isScheduledAutomationTrigger(value: string): value is AutomationTrigger {
  return (SCHEDULED_AUTOMATION_TRIGGERS as ReadonlySet<string>).has(value);
}

export function triggerLabel(value: string): string {
  return AUTOMATION_TRIGGERS.find((trigger) => trigger.value === value)?.label ?? value.replaceAll("_", " ");
}

export function actionLabel(value: string): string {
  return AUTOMATION_ACTIONS.find((action) => action.value === value)?.label ?? value.replaceAll("_", " ");
}

/**
 * EVERYTHING THE CRM DOES ON ITS OWN — one list, shown in full on Settings →
 * Automatic jobs & messages. Nothing may run hidden (2026-10-06: a customer got
 * an automatic WhatsApp signing reminder that no screen anywhere mentioned).
 *
 * Every cron route, every cron phase and every automatic message to a customer
 * has an entry here; tests/automationRegister.test.ts fails the build when one
 * runs without it. Pure (no imports), so the page and the test read the same list.
 *
 * `reaches`: who can receive something because of it. Anything that reaches a
 * CUSTOMER either has its own switch here, OFF unless the owner turns it on, or
 * is switched on deliberately somewhere else (`managedAt`) — and says where.
 *
 * ONE ENGINE FOR AUTOMATIC CUSTOMER MESSAGES (2026-10-06): journeys. The review
 * requests, service-due, signing and survey reminders that were hard-coded here
 * are READY_MADE_JOURNEYS below — off by default, edited and switched on Journeys.
 * A customer entry that is not the journeys engine must say why (`notJourney`):
 * it is part of something a person sent or switched on for that one item.
 */
export type AutomationReach = "customer" | "staff" | "nobody";

export type Automation = {
  key: string;
  label: string;
  /** What it does, in plain words, including what it sends and to whom. */
  does: string;
  reaches: AutomationReach;
  channels?: string[];
  /** When it runs. */
  when: string;
  /** Its own on/off switch (an AppSetting per workspace). */
  setting?: { key: string; defaultOn: boolean };
  /** Switched on, set up or approved on another screen — where. */
  managedAt?: { label: string; href: string };
  /**
   * The messages it sends, by template (Settings → Email templates) — each shown
   * with a link that opens it to read and edit. Every customer message has one.
   */
  messages?: string[];
  /** Messages written somewhere other than the templates — where to read and edit them. */
  messagesAt?: { label: string; href: string };
  /** Cron route path and phase name(s) that run it — read by the guard test. */
  cron?: string;
  phases?: string[];
  /** Other work a cron route runs directly (not as a named phase) — read by the guard test. */
  jobs?: string[];
  /**
   * A customer message that is NOT a journey says why — it is part of something a
   * person sent, or switched on for that one item. The guard test holds the list.
   */
  notJourney?: string;
};

/**
 * The customer messages that used to be built-in senders, as journeys every
 * workspace gets (readyMadeJourneys.ts creates them). Each starts OFF — or ON
 * only where the old switch (`priorSwitch`) was explicitly stored on, so nothing
 * that was being sent stops and nothing that wasn't starts.
 */
export type ReadyMadeJourney = {
  key: string;
  name: string;
  description: string;
  /** The old on/off setting — read once, as the owner's prior approval. */
  priorSwitch: string;
  channels: string[];
  /** Editable templates (Settings → Email templates) its step sends. */
  messages: string[];
  triggers: Array<{ type: string; config: Record<string, unknown> }>;
  steps: Array<{ id: string; type: string; config: Record<string, unknown> }>;
};

export const READY_MADE_JOURNEYS: ReadyMadeJourney[] = [
  {
    key: "review-requests",
    name: "Google review request",
    description:
      "Emails the customer asking for a Google review after a job card is completed or a vehicle is registered as a new delivery — at most once per customer every 90 days, and never to someone who opted out.",
    priorSwitch: "REVIEW_REQUESTS_AUTO",
    channels: ["email"],
    messages: ["review_delivery", "review_service"],
    triggers: [
      { type: "job_completed", config: {} },
      { type: "vehicle_delivered", config: {} },
    ],
    steps: [{ id: "review", type: "send_review_request", config: {} }],
  },
  {
    key: "service-reminders",
    name: "Service-due reminder",
    description:
      "Emails a customer when their vehicle is due (or overdue) for a service — once per service, using the template picked under Settings → Email → Service reminders, or the Service reminder template.",
    priorSwitch: "SERVICE_REMINDER_ENABLED",
    channels: ["email"],
    messages: ["service_reminder"],
    triggers: [{ type: "service_due", config: {} }],
    steps: [{ id: "remind", type: "send_service_reminder", config: {} }],
  },
  {
    key: "signing-reminders",
    name: "Signing reminder",
    description:
      "One reminder, with their own signing link, to a signer who hasn't signed three days after the document reached them.",
    priorSwitch: "SIGNING_AUTO_REMINDERS",
    channels: ["email", "WhatsApp"],
    messages: ["reminder", "reminder_whatsapp"],
    triggers: [{ type: "signing_unsigned", config: { days: 3 } }],
    steps: [{ id: "remind", type: "send_signing_reminder", config: {} }],
  },
  {
    key: "survey-reminders",
    name: "Survey reminder (automatic surveys)",
    description:
      "One reminder, 48 hours later, to a customer who hasn't answered a survey sent automatically (after a job card, a delivery or a won deal).",
    priorSwitch: "SURVEY_AUTO_REMINDERS",
    channels: ["email", "SMS"],
    messages: ["survey_reminder", "survey_reminder_sms"],
    triggers: [{ type: "survey_unanswered", config: { hours: 48 } }],
    steps: [{ id: "remind", type: "send_survey_reminder", config: {} }],
  },
];

/** The AppSetting that records which journey a workspace got for a ready-made one. */
export const readyMadeMarkerKey = (key: string) => `READY_MADE_JOURNEY:${key}`;

export const AUTOMATIONS: Automation[] = [
  /* ── Messages that can reach a customer ─────────────────────────────── */
  {
    key: "journeys",
    messagesAt: { label: "each journey's steps", href: "/journeys" },
    label: "Journeys",
    does: "Every automatic message to a customer: the ready-made journeys (review requests, service-due, signing and survey reminders) and any you build. Tasks for the team too. A journey only runs once published and switched on.",
    reaches: "customer",
    channels: ["email", "SMS", "WhatsApp"],
    when: "Every 30 minutes, and when the thing it listens for happens",
    managedAt: { label: "Journeys", href: "/journeys" },
    cron: "/api/cron/journeys",
  },
  {
    key: "signed-copies",
    notJourney: "Part of a signing request a person sent: the copy of what they signed.",
    messages: ["completed"],
    label: "Signed copies",
    does: "When everyone has signed, the signed PDF is emailed to each person on the request who has an email address.",
    reaches: "customer",
    channels: ["email"],
    when: "When a signing request completes (and a retry sweep every 30 minutes)",
    setting: { key: "SIGNING_SIGNED_COPIES", defaultOn: true },
    cron: "/api/cron/automations",
    phases: ["stranded-completions"],
  },
  {
    key: "signing-next-signer",
    notJourney: "Part of a signing request a person sent, in the order they set: the next person's invitation.",
    messages: ["invite", "invite_whatsapp"],
    label: "Next signer in line",
    does: "In a request signed in order (e.g. our team, then the customer), the next person's signing link goes out when the one before them signs. Part of the request a person sent — the order is set when it is sent.",
    reaches: "customer",
    channels: ["email", "WhatsApp"],
    when: "When the person before them signs or approves",
    managedAt: { label: "Signing workflows", href: "/settings/signing-workflows" },
    cron: "/api/cron/signing-jobs",
  },
  {
    key: "surveys",
    notJourney: "Each survey is published and switched on by a person; reminders here are only the ones a person chose when sending to an audience.",
    messages: ["survey_invite", "survey_invite_sms", "survey_reminder", "survey_reminder_sms"],
    label: "Survey invitations",
    does: "Sends surveys: ones a person sends to an audience (with the reminders they chose), and ones a survey is set to send by itself (after a job card, a delivery or a won deal). A survey only sends once it is published and switched on. Reminders for the automatic ones are the Survey reminder journey.",
    reaches: "customer",
    channels: ["email", "SMS"],
    when: "Every 30 minutes",
    managedAt: { label: "Surveys", href: "/surveys" },
    cron: "/api/cron/automations",
    phases: ["survey-distribution-queue"],
  },
  {
    key: "campaigns",
    notJourney: "A person writes each campaign and a second person approves it.",
    messagesAt: { label: "each campaign", href: "/marketing/campaigns" },
    label: "Marketing campaigns",
    does: "Sends a campaign a person wrote and a second person approved, now or at its scheduled time.",
    reaches: "customer",
    channels: ["email", "SMS"],
    when: "Every 30 minutes",
    managedAt: { label: "Campaigns", href: "/marketing/campaigns" },
    cron: "/api/cron/automations",
    phases: ["campaign-queue"],
  },
  {
    key: "chatbot",
    notJourney: "A reply to a customer who messaged first, while the chatbot is switched on.",
    messagesAt: { label: "the chatbot", href: "/chatbot" },
    label: "Chatbot replies and retries",
    does: "Replies to customers who message on WhatsApp, Messenger, Instagram or Telegram, when the chatbot is on — and retries any reply (a person's or the bot's) that failed to deliver, for about an hour.",
    reaches: "customer",
    channels: ["WhatsApp", "Messenger", "Instagram", "Telegram"],
    when: "When a customer messages; retries every 30 minutes",
    managedAt: { label: "Chatbot", href: "/chatbot" },
    cron: "/api/cron/bot-outbox",
  },
  {
    key: "inbound-email",
    notJourney: "An acknowledgement to a customer who emailed first, only for a mailbox whose auto-reply is switched on.",
    messagesAt: { label: "each mailbox's auto-reply", href: "/settings/helpdesk" },
    label: "Inbound email and help-desk auto-reply",
    does: "Collects incoming email into the inbox and help desk; sends an acknowledgement to the customer only if a mailbox's auto-reply is on.",
    reaches: "customer",
    channels: ["email"],
    when: "Every 30 minutes",
    managedAt: { label: "Help desk", href: "/settings/helpdesk" },
    cron: "/api/cron/automations",
    phases: ["imap-sync"],
  },

  /* ── For the team only ───────────────────────────────────────────────── */
  {
    key: "activity-reminders",
    label: "Activity reminders",
    does: "Phone notifications to the team for calls and meetings coming up.",
    reaches: "staff",
    channels: ["push"],
    when: "Every 30 minutes",
    cron: "/api/cron/automations",
    phases: ["activity-reminders"],
  },
  {
    key: "assistant-schedules",
    label: "Scheduled DAX questions",
    does: "Answers questions a person scheduled for themselves, as them, and tells them it's ready.",
    reaches: "staff",
    channels: ["push"],
    when: "Every 30 minutes",
    managedAt: { label: "Ask DAX", href: "/assistant" },
    cron: "/api/cron/assistant",
  },
  {
    key: "lead-research",
    label: "Lead research and DAX tidy-up",
    does: "Researches new leads with ChatGPT for the lead page, and once a day tidies what DAX has learned.",
    reaches: "nobody",
    when: "Every 30 minutes",
    cron: "/api/cron/research",
  },
  {
    key: "signing-housekeeping",
    label: "Signing housekeeping",
    does: "Finishes signing work that was interrupted (seals, records, retries) and releases stuck claims. Sends what the signing request itself sends — see Next signer and Signed copies.",
    reaches: "nobody",
    when: "Every 30 minutes",
    cron: "/api/cron/automations",
    phases: ["stale-signing-claims"],
  },
  {
    key: "lead-sync",
    label: "Facebook lead ads and Google reviews",
    does: "Imports new Facebook lead-ad leads and new Google reviews into the CRM. Sends nothing.",
    reaches: "nobody",
    when: "Every 30 minutes",
    managedAt: { label: "Integrations", href: "/settings/integrations" },
    cron: "/api/cron/automations",
    phases: ["meta-lead-sync", "google-reviews"],
  },
  {
    key: "stock-expiry",
    label: "Stock reservation expiry",
    does: "Releases stock reservations that have run out.",
    reaches: "nobody",
    when: "Every 30 minutes",
    cron: "/api/cron/automations",
    phases: ["stock-actor", "stock-reservation-expiry"],
  },
  {
    key: "repairs",
    label: "Data repair checks",
    does: "Looks for records that need repairing and lists them for a person to fix. Changes nothing.",
    reaches: "nobody",
    when: "Every 30 minutes",
    cron: "/api/cron/automations",
    phases: ["repairs-detectors"],
  },
  {
    key: "statistics",
    label: "Reporting figures",
    does: "Rolls up the numbers behind reports and the dashboard.",
    reaches: "nobody",
    when: "Every 30 minutes",
    cron: "/api/cron/statistics",
  },
  {
    key: "competitor-watch",
    label: "Competitor watch",
    does: "Checks competitors' public pages for changes once a day.",
    reaches: "nobody",
    when: "Daily",
    cron: "/api/cron/competitor-watch",
  },
  {
    key: "backup",
    label: "Backups",
    does: "Backs up the workspace's data.",
    reaches: "nobody",
    when: "Daily",
    cron: "/api/cron/backup",
  },
  {
    key: "storage-cleanup",
    label: "File clean-up",
    does: "Deletes photos that were uploaded but never saved to a record, and moves files into private storage.",
    reaches: "nobody",
    when: "Daily",
    cron: "/api/cron/photo-orphans",
  },
  {
    key: "private-storage",
    label: "Private file storage",
    does: "Moves stored files into the private store.",
    reaches: "nobody",
    when: "Daily",
    cron: "/api/cron/private-storage",
  },
  {
    key: "maintenance",
    label: "System maintenance",
    does: "Clears out expired sign-in rate-limit records and similar housekeeping. Sends nothing.",
    reaches: "nobody",
    when: "Every 30 minutes",
    cron: "/api/cron/automations",
    jobs: ["runGlobalMaintenance"],
  },
  {
    key: "health-watch",
    label: "AI and backup health watch",
    does: "Checks once an hour that the AI connection works and that backups are running; notifies the owner when one breaks.",
    reaches: "staff",
    channels: ["push"],
    when: "Hourly",
    cron: "/api/cron/automations",
    jobs: ["runAiHealthIfDue", "runBackupWatchdog"],
  },
  {
    key: "security-checks",
    label: "Security checks",
    does: "Monthly security check of the install; notifies the platform owner of problems.",
    reaches: "staff",
    channels: ["push"],
    when: "Monthly",
    cron: "/api/cron/security",
  },
];

/** The switch's value when nobody has set it. */
export function automationDefault(key: string): boolean {
  return AUTOMATIONS.find((a) => a.setting?.key === key)?.setting?.defaultOn ?? false;
}

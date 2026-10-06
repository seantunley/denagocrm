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
  /** Cron route path and phase name(s) that run it — read by the guard test. */
  cron?: string;
  phases?: string[];
  /** Other work a cron route runs directly (not as a named phase) — read by the guard test. */
  jobs?: string[];
};

export const AUTOMATIONS: Automation[] = [
  /* ── Messages that can reach a customer ─────────────────────────────── */
  {
    key: "signing-reminders",
    label: "Signing reminders",
    does: "One reminder to a signer who hasn't signed three days after the document reached them — and a re-nudge to the next signer in line if they haven't opened theirs.",
    reaches: "customer",
    channels: ["email", "WhatsApp"],
    when: "Every 30 minutes",
    setting: { key: "SIGNING_AUTO_REMINDERS", defaultOn: false },
    cron: "/api/cron/automations",
    phases: ["signature-request-reminders"],
  },
  {
    key: "signed-copies",
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
    label: "Next signer in line",
    does: "In a request signed in order (e.g. our team, then the customer), the next person's signing link goes out when the one before them signs. Part of the request a person sent — the order is set when it is sent.",
    reaches: "customer",
    channels: ["email", "WhatsApp"],
    when: "When the person before them signs or approves",
    managedAt: { label: "Signing workflows", href: "/settings/signing-workflows" },
    cron: "/api/cron/signing-jobs",
  },
  {
    key: "review-requests",
    label: "Google review requests",
    does: "Emails the customer asking for a Google review after a job card is completed or a new vehicle is delivered — at most once per customer every 90 days, and never to someone who opted out.",
    reaches: "customer",
    channels: ["email"],
    when: "When a job card is completed, or a vehicle is registered as a new delivery",
    setting: { key: "REVIEW_REQUESTS_AUTO", defaultOn: false },
  },
  {
    key: "survey-auto-reminders",
    label: "Survey reminders (automatic surveys)",
    does: "One reminder, 48 hours later, to a customer who hasn't answered a survey sent automatically (after a job card, a delivery or a won deal).",
    reaches: "customer",
    channels: ["email", "SMS"],
    when: "48 hours after the survey",
    setting: { key: "SURVEY_AUTO_REMINDERS", defaultOn: false },
  },
  {
    key: "surveys",
    label: "Survey invitations",
    does: "Sends surveys: ones a person sends to an audience, and ones a survey is set to send by itself (after a job card, a delivery or a won deal). A survey only sends once it is published and switched on.",
    reaches: "customer",
    channels: ["email", "SMS"],
    when: "Every 30 minutes",
    managedAt: { label: "Surveys", href: "/surveys" },
    cron: "/api/cron/automations",
    phases: ["survey-distribution-queue"],
  },
  {
    key: "service-reminders",
    label: "Service-due reminders",
    does: "Emails a customer when their vehicle is due for a service.",
    reaches: "customer",
    channels: ["email"],
    when: "Every 30 minutes",
    setting: { key: "SERVICE_REMINDER_ENABLED", defaultOn: false },
    managedAt: { label: "Settings → Service reminders", href: "/settings?tab=email" },
    cron: "/api/cron/automations",
    phases: ["service-reminders"],
  },
  {
    key: "campaigns",
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
    key: "journeys",
    label: "Journeys",
    does: "Runs the steps of active journeys — tasks for the team, and emails or SMS to customers only where a journey has a send step. A journey only runs once published and active.",
    reaches: "customer",
    channels: ["email", "SMS"],
    when: "Every 30 minutes",
    managedAt: { label: "Journeys", href: "/journeys" },
    cron: "/api/cron/journeys",
  },
  {
    key: "chatbot",
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

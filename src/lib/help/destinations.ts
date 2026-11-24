/**
 * "Take me there": the screen a help article is about (2026-11-23), so a guide
 * can offer "Open Quotes" instead of describing where Quotes is.
 *
 * Pure data. An exact slug wins over a prefix, and prefixes are tried in order,
 * so the specific ones are listed first. An article with no entry simply has no
 * button — a guide about conventions has no one screen to open, and a wrong
 * button is worse than none. tests/helpFrontDoor.test.ts checks that every
 * href here is a real page.
 *
 * The button is a plain link: the page it opens still decides who may see it,
 * exactly as if the person had used the menu.
 */
export type HelpDestination = { href: string; label: string };

const EXACT: Record<string, HelpDestination> = {
  "home-screen": { href: "/", label: "Home" },
  "leads-test-drives": { href: "/test-drives", label: "Test Drives" },
  "contacts-merge-duplicates": { href: "/duplicates", label: "Duplicates" },
  "activities-calendar": { href: "/calendar", label: "Calendar" },
  "activities-queue": { href: "/activities", label: "Activities" },
  "customer-health": { href: "/health", label: "Customer health" },
  "today-who-to-contact-next": { href: "/today", label: "Today" },
  "email-signatures": { href: "/email-signatures", label: "Email signatures" },
  "helpdesk-settings": { href: "/settings/helpdesk", label: "Help desk settings" },
  "stock-products-catalogue": { href: "/products", label: "Products" },
  "stock-parts-inventory": { href: "/parts", label: "Parts" },
  "workshop-calendar-bookings": { href: "/workshop-calendar", label: "Workshop calendar" },
  "service-due-scheduling": { href: "/service-due", label: "Service Due" },
  "warranty-claims-recalls": { href: "/warranty", label: "Warranty" },
  "settings-workshop-configuration": { href: "/settings/workshop", label: "Workshop settings" },
  "marketing-overview-and-calendar": { href: "/marketing", label: "Marketing" },
  "automations-rules": { href: "/automations", label: "Automations" },
  "signing-workflows-builder": { href: "/settings/signing-workflows", label: "Signing workflows" },
  "admin-signing-workflows": { href: "/settings/signing-workflows", label: "Signing workflows" },
  "signing-security-settings": { href: "/settings/signing-security", label: "Signing security" },
  "signature-banners": { href: "/settings/signature-banners", label: "Signature banners" },
  "assistant-settings": { href: "/settings/assistant", label: "Assistant settings" },
  "admin-settings-overview": { href: "/settings", label: "Settings" },
  "admin-company-profile": { href: "/settings/company", label: "Company settings" },
  "admin-roles-permissions": { href: "/settings/access", label: "Access settings" },
  "admin-team-user-management": { href: "/settings/access", label: "Access settings" },
  "admin-pipelines": { href: "/settings/pipelines", label: "Pipeline settings" },
  "admin-portal-access": { href: "/settings/portal-access", label: "Portal access" },
  "admin-backup-recovery": { href: "/settings/backup-recovery", label: "Backup & recovery" },
  "admin-sessions-devices": { href: "/settings/sessions", label: "Sessions & devices" },
  "admin-integrations": { href: "/settings/integrations", label: "Integrations" },
  "admin-documents-templates": { href: "/settings/documents", label: "Document settings" },
  "admin-configure-guided-checklists": { href: "/settings/checklists", label: "Checklist settings" },
  "automatic-jobs-and-messages": { href: "/settings/automatic", label: "Automatic jobs & messages" },
  "background-queues": { href: "/settings/queues", label: "Background queues" },
  "lead-routing": { href: "/settings/lead-routing", label: "Lead routing" },
  "custom-fields": { href: "/settings/custom-fields", label: "Custom fields" },
  "activity-types": { href: "/settings/activity-types", label: "Activity types" },
  "audit-event-log": { href: "/audit", label: "Audit log" },
  "trash-recycle-bin": { href: "/trash", label: "Recycle bin" },
  "repairs-issue-list": { href: "/repairs", label: "Repairs" },
  "reports-sales-dashboard": { href: "/reports", label: "Reports" },
  "deliveries-board": { href: "/deliveries", label: "Deliveries" },
  "referrals-overview": { href: "/referrals", label: "Referrals" },
  "fleets-management": { href: "/fleets", label: "Fleets" },
};

const PREFIX: ReadonlyArray<{ prefix: string } & HelpDestination> = [
  { prefix: "dashboards-", href: "/", label: "Home" },
  { prefix: "leads-", href: "/leads", label: "Leads" },
  { prefix: "contacts-", href: "/contacts", label: "Contacts" },
  { prefix: "quotes-", href: "/quotes", label: "Quotes" },
  { prefix: "targets-", href: "/targets", label: "Targets" },
  { prefix: "forecast-", href: "/forecast", label: "Forecast" },
  { prefix: "signatures-", href: "/signatures", label: "Signatures" },
  { prefix: "stock-vehicles-", href: "/vehicles", label: "Vehicles" },
  { prefix: "stock-", href: "/stock", label: "Stock" },
  { prefix: "jobcards-", href: "/jobcards", label: "Job Cards" },
  { prefix: "test-drives-", href: "/test-drives", label: "Test Drives" },
  { prefix: "inbox-", href: "/inbox", label: "Inbox" },
  { prefix: "cases-", href: "/cases", label: "Help desk" },
  { prefix: "connect-", href: "/settings/integrations", label: "Integrations" },
  { prefix: "campaigns-", href: "/campaigns", label: "Campaigns" },
  { prefix: "surveys-", href: "/surveys", label: "Surveys" },
  { prefix: "survey-", href: "/surveys", label: "Surveys" },
  { prefix: "journeys-", href: "/journeys", label: "Journeys" },
  { prefix: "chatbot-", href: "/chatbot", label: "Chatbot" },
  { prefix: "flow-builder-", href: "/bot-builder", label: "Flow builder" },
  { prefix: "competitors-", href: "/competitors", label: "Competitors" },
  { prefix: "assistant-", href: "/assistant", label: "Ask the CRM" },
  { prefix: "documents-", href: "/documents", label: "Documents" },
  { prefix: "library-", href: "/library", label: "Library" },
  { prefix: "studio-", href: "/document-studio", label: "Document Studio" },
];

/** Every destination, for the test that checks each one is a real page. */
export const HELP_DESTINATIONS: readonly HelpDestination[] = [...Object.values(EXACT), ...PREFIX];

/** The screen this article is about, or null when it is not about one screen. */
export function destinationFor(slug: string): HelpDestination | null {
  const exact = EXACT[slug];
  if (exact) return exact;
  const match = PREFIX.find((rule) => slug.startsWith(rule.prefix));
  return match ? { href: match.href, label: match.label } : null;
}

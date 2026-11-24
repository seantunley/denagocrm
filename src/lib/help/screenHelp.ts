/**
 * HELP WHERE YOU WORK (Sean, 2026-11-23): the "?" in the top bar opens the guide for the screen you're on, in a side
 * panel, so nobody has to leave what they're doing. This maps a screen to its article.
 *
 * Pure data — no server or React imports — so the button, the API route and the coverage test all read the same map.
 * A pattern is a path; a "*" segment matches any one segment (a record's id). The most specific pattern wins.
 * Settings tabs (/settings?tab=…) have their own map.
 */
const SCREENS: ReadonlyArray<readonly [pattern: string, slug: string]> = [
  ["/", "home-screen"],
  ["/today", "today-who-to-contact-next"],
  ["/work", "my-work"],
  ["/assistant", "assistant-ask-the-crm"],
  ["/search", "search-and-command-menu"],
  ["/notifications", "admin-notifications"],
  ["/repairs", "repairs-issue-list"],

  // Customers and sales
  ["/leads", "leads-pipeline-overview"],
  ["/leads/*", "leads-working-a-lead"],
  ["/leads/new", "leads-create-a-lead"],
  ["/leads/list", "leads-list-and-saved-views"],
  ["/leads/attention", "attention-centre-guide"],
  ["/leads/closed", "leads-list-and-saved-views"],
  ["/leads/nurture", "leads-working-a-lead"],
  ["/contacts", "contacts-overview"],
  ["/contacts/new", "contacts-overview"],
  ["/contacts/*", "contacts-profile"],
  ["/duplicates", "contacts-merge-duplicates"],
  ["/activities", "activities-queue"],
  ["/calendar", "activities-calendar"],
  ["/fleets", "fleets-management"],
  ["/health", "customer-health"],
  ["/deals", "deal-workspace"],
  ["/deals/*", "deal-workspace"],
  ["/quotes", "quotes-overview"],
  ["/quotes/*", "quotes-send-revise-lock"],
  ["/deliveries", "deliveries-board"],
  ["/finance", "deal-finance"],
  ["/targets", "targets-monthly-goals"],
  ["/forecast", "forecast-sales-pipeline"],
  ["/referrals", "referrals-overview"],
  ["/signatures", "signatures-hub"],
  ["/signatures/*", "signatures-request-page"],
  ["/signing-workflows", "signing-workflows-builder"],

  // Stock and workshop
  ["/stock", "stock-operations-overview"],
  ["/products", "stock-products-catalogue"],
  ["/parts", "stock-parts-inventory"],
  ["/vehicles", "stock-vehicles-registration"],
  ["/vehicles/*", "stock-vehicles-service-and-mileage"],
  ["/jobcards", "jobcards-overview"],
  ["/jobcards/*", "jobcards-workflow-stages"],
  ["/workshop-calendar", "workshop-calendar-bookings"],
  ["/service-due", "service-due-scheduling"],
  ["/warranty", "warranty-claims-recalls"],
  ["/test-drives", "test-drives-booking-and-statuses"],

  // Documents
  ["/documents", "documents-repository-overview"],
  ["/library", "library-overview-and-versioning"],
  ["/document-studio", "studio-overview"],
  ["/email-signatures", "email-signatures"],

  // Marketing and automation
  ["/marketing", "marketing-overview-and-calendar"],
  ["/campaigns", "campaigns-overview"],
  ["/surveys", "surveys-overview"],
  ["/automations", "automations-rules"],
  ["/journeys", "journeys-overview"],
  ["/chatbot", "chatbot-setup"],
  ["/bot-builder", "flow-builder-overview"],
  ["/bot-analytics", "chatbot-analytics"],
  ["/competitors", "competitors-overview"],

  // Conversations
  ["/inbox", "inbox-overview"],
  ["/cases", "cases-overview"],
  ["/cases/*", "cases-working-a-ticket"],

  // Oversight
  ["/d/*", "dashboards-overview"],
  ["/d/command-centre", "command-centre"],
  ["/d/team", "command-centre"],
  ["/d/sales-dashboard", "command-centre"],
  ["/d/operations", "command-centre"],
  ["/reports", "reports-sales-dashboard"],
  ["/audit", "audit-event-log"],
  ["/trash", "trash-recycle-bin"],

  // Settings
  ["/settings", "admin-settings-overview"],
  ["/settings/company", "admin-company-profile"],
  ["/settings/access", "admin-roles-permissions"],
  ["/settings/lead-routing", "lead-routing"],
  ["/settings/portal-access", "admin-portal-access"],
  ["/settings/sessions", "admin-sessions-devices"],
  ["/settings/pipelines", "admin-pipelines"],
  ["/settings/activity-types", "activity-types"],
  ["/settings/custom-fields", "custom-fields"],
  ["/settings/checklists", "admin-configure-guided-checklists"],
  ["/settings/workshop", "settings-workshop-configuration"],
  ["/settings/signature-banners", "signature-banners"],
  ["/settings/helpdesk", "helpdesk-settings"],
  ["/settings/integrations", "admin-integrations"],
  ["/settings/signing-workflows", "admin-signing-workflows"],
  ["/settings/signing-security", "signing-security-settings"],
  ["/settings/assistant", "assistant-settings"],
  ["/settings/automatic", "automatic-jobs-and-messages"],
  ["/settings/security", "admin-security-runbook"],
  ["/settings/backup-recovery", "admin-backup-recovery"],
  ["/settings/queues", "background-queues"],
  ["/settings/documents", "admin-documents-templates"],
  // Screens whose guides came with the help review (articles/screens.ts).
  ["/invoices", "invoices-overview"],
  ["/birthdays", "birthdays"],
  ["/data-quality", "data-quality"],
  ["/settings/vendors", "suppliers"],
  ["/settings/public-holidays", "public-holidays"],
  ["/settings/plan", "plan-and-billing"],
  ["/settings/clock-weather", "clock-and-weather"],
];

/** The tabs of the main Settings page that have a guide of their own. */
const SETTINGS_TABS: Readonly<Record<string, string>> = {
  account: "admin-my-account-profile",
  notifications: "admin-notifications",
  team: "admin-team-user-management",
  automations: "automations-rules",
  stock: "admin-catalog-settings",
  products: "stock-products-catalogue",
  workshop: "settings-workshop-configuration",
};

/**
 * Screens with no "?" on purpose: the Help Centre itself, and screens with no guide written yet. The coverage test
 * fails for any other screen left out, so a new screen gets a guide (or a reason) when it is built.
 */
export const SCREENS_WITHOUT_HELP: Readonly<Record<string, string>> = {
  "/help": "the Help Centre itself",
  "/d": "a short link that redirects",
  "/comments": "redirects to the inbox's Comments tab",
  "/settings/modules": "platform owner only",
  "/settings/integration-overrides": "platform owner only",
};

const segments = (path: string) => path.split("/").filter(Boolean);

function matches(pattern: string, path: string): boolean {
  const want = segments(pattern);
  const have = segments(path);
  return want.length === have.length && want.every((part, i) => part === "*" || part === have[i]);
}

/** Exact beats wildcard; a longer pattern beats a shorter one. */
const rank = (pattern: string) => segments(pattern).length * 2 - (pattern.includes("*") ? 1 : 0);

/**
 * The guide for a screen, or null. A record's sub-page (/quotes/123/print) falls back to the nearest screen above it
 * that has a guide.
 */
export function helpSlugForScreen(pathname: string, search = ""): string | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/settings") {
    const tab = new URLSearchParams(search).get("tab");
    if (tab && SETTINGS_TABS[tab]) return SETTINGS_TABS[tab];
  }
  if (path === "/") return "home-screen";
  // Never up to "/": a screen with no guide gets none, not the Home guide.
  for (let parts = segments(path); parts.length > 0; parts = parts.slice(0, -1)) {
    const candidate = `/${parts.join("/")}`;
    if (SCREENS_WITHOUT_HELP[candidate]) return null;
    const best = SCREENS.filter(([pattern]) => matches(pattern, candidate)).sort((a, b) => rank(b[0]) - rank(a[0]))[0];
    if (best) return best[1];
  }
  return null;
}

/** Every slug the map points at — the coverage test checks each is a real article. */
export const SCREEN_HELP_SLUGS: readonly string[] = [...new Set([...SCREENS.map(([, slug]) => slug), ...Object.values(SETTINGS_TABS)])];
/** Every mapped screen pattern — for the coverage test. */
export const SCREEN_PATTERNS: readonly string[] = SCREENS.map(([pattern]) => pattern);

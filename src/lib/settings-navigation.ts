import type { ModuleId } from "@/lib/modules/registry";

export type SettingsNavItem = {
  key: string;
  label: string;
  href?: string;
  keywords?: string[];
  /** Visible to every signed-in user (e.g. their own account), not just owners. */
  everyone?: boolean;
  /** Visible to owners, or to non-owners holding this permission (or any of them). Mirrors the page's own guard. */
  permission?: string | string[];
  /** Optional feature pack this surface belongs to. Hidden when the module is off. */
  module?: ModuleId;
  /**
   * PLATFORM-level (the whole install, not one workspace): shown only to the
   * platform owner, never to a workspace owner. Mirrors the page's requireOwner().
   */
  platform?: boolean;
};

/**
 * WHO a group is for (settings reorganisation, 2026-11-12): the person's own
 * account, the workspace's setup, and the admin of the system itself. The menu
 * and the settings home show these as three headings.
 */
export type SettingsArea = "account" | "workspace" | "admin";

export const SETTINGS_AREAS: ReadonlyArray<{ key: SettingsArea; label: string; description: string }> = [
  { key: "account", label: "My account", description: "Your own profile, sign-in and notifications." },
  { key: "workspace", label: "Workspace", description: "How this workspace is set up — for everyone in it." },
  { key: "admin", label: "Admin", description: "The system itself: modules, security, backups and what runs in the background." },
];

export type SettingsNavGroup = {
  label: string;
  area: SettingsArea;
  /** One line on what is in it — shown on the settings home. */
  description: string;
  items: SettingsNavItem[];
};

/**
 * Shared source of truth for the settings page and application search.
 *
 * Split first by WHO the setting is for (`area`), then by the job it does
 * (settings-reorganisation-plan.md, stage 1). Only groups, order and labels
 * changed here — every entry keeps its key, address and access rule.
 */
export const SETTINGS_NAV_GROUPS: SettingsNavGroup[] = [
  {
    label: "My account",
    area: "account",
    description: "Your profile, password, passkeys and what notifies you.",
    items: [
      { key: "account", label: "Profile & sign-in", everyone: true, keywords: ["my account", "profile", "name", "email", "phone", "photo", "job title", "password", "passkey", "signature"] },
      // Owner-only today (decision 1 in the plan: opening it to everyone is its own change).
      { key: "notifications", label: "Notifications", keywords: ["alerts", "push", "email preferences"] },
    ],
  },
  {
    label: "Business",
    area: "workspace",
    description: "Company details, opening days, the plan, and the clock on everyone's screen.",
    items: [
      { key: "company", label: "Company profile", href: "/settings/company", keywords: ["business", "address", "phone", "branding", "footer", "logo", "details"] },
      { key: "public-holidays", label: "Public holidays", href: "/settings/public-holidays", keywords: ["holidays", "public holidays", "closed", "closed days", "shutdown", "country", "opening hours", "office hours"] },
      { key: "plan", label: "Plan & billing", href: "/settings/plan", keywords: ["plan", "billing", "invoice", "usage", "subscription", "ai usage", "allowance"] },
      // A workspace setting (every screen in it shows these cities), so not under My account.
      { key: "clock-weather", label: "Clock & weather", href: "/settings/clock-weather", keywords: ["clock", "time", "weather", "cities", "timezone", "city", "temperature"] },
    ],
  },
  {
    label: "People & access",
    area: "workspace",
    description: "Who works here, what they can do, who gets which leads, and who is signed in.",
    items: [
      { key: "team", label: "Team & roles", href: "/settings/access", permission: ["teams.view", "roles.view", "teams.manage", "roles.manage"], keywords: ["team & access", "users", "staff", "members", "roles", "permissions"] },
      // Owner-only (no `permission`, not `everyone`): mirrors the page and action's requireTenantOwner().
      { key: "lead-routing", label: "Lead routing", href: "/settings/lead-routing", keywords: ["assign", "assignment", "round robin", "auto-assign", "distribute", "leads", "reps", "owner", "inbound"] },
      { key: "portal-access", label: "Portal access", href: "/settings/portal-access", permission: "portal_access.manage", keywords: ["customer portal", "delegation", "profile requests"] },
      // Everyone's sessions in the workspace, owner-only — so here, not under My account.
      { key: "sessions", label: "Sessions & devices", href: "/settings/sessions", keywords: ["devices", "logins", "sign out"] },
    ],
  },
  {
    label: "Sales",
    area: "workspace",
    description: "The pipeline, activity types, quote defaults and suppliers.",
    items: [
      { key: "pipeline", label: "Pipeline", href: "/settings/pipelines", permission: "pipelines.manage", keywords: ["lead stages", "sales stages"] },
      { key: "activity-types", label: "Activity types", href: "/settings/activity-types", keywords: ["activity", "activities", "types", "task", "tasks", "diary", "calendar", "meeting", "call", "test drive", "golf day", "custom type", "location"] },
      { key: "quotes", label: "Quotes", keywords: ["quote defaults", "terms"] },
      // Owner-only (no `permission`): mirrors the page and action's requireTenantOwner().
      { key: "vendors", label: "Suppliers", href: "/settings/vendors", module: "suppliers", keywords: ["suppliers", "vendors", "oem", "delivery company", "transport", "wrapping", "deal file", "supplier invoice", "proof of payment"] },
    ],
  },
  {
    label: "Records",
    area: "workspace",
    description: "What gets recorded: custom fields, checklists, and bringing records in.",
    items: [
      { key: "custom-fields", label: "Custom fields", href: "/settings/custom-fields", keywords: ["custom", "fields", "eav", "extra", "attributes", "metadata", "contact fields", "lead fields", "properties"] },
      // Beside custom fields: both decide what gets recorded against a record, and
      // a checklist is not tied to one module — it configures deliveries, workshop
      // check-ins and vehicle condition reports from one screen. The permission
      // mirrors the page's own guard, which mirrors the action's, so the entry
      // cannot advertise a screen the viewer would be redirected away from.
      { key: "checklists", label: "Checklists", href: "/settings/checklists", permission: "document_templates.manage", keywords: ["checklist", "checklists", "handover", "inspection", "photos", "capture", "steps", "delivery", "check-in", "condition report"] },
      { key: "import", label: "Import", keywords: ["contacts", "csv", "upload"] },
    ],
  },
  {
    label: "Workshop & stock",
    area: "workspace",
    description: "Workshop bookings, bays and rates, the product catalogue and stock labels.",
    items: [
      { key: "workshop", label: "Bookings & slots", module: "automotive", keywords: ["schedule", "calendar", "hours"] },
      { key: "workshop-settings", label: "Workshop settings", href: "/settings/workshop", permission: "workshop.manage", module: "automotive", keywords: ["bays", "labour rate", "packages", "workshop"] },
      { key: "products", label: "Products", module: "commerce", keywords: ["catalog", "pricing"] },
      { key: "stock", label: "Stock labels", module: "commerce", keywords: ["stock", "inventory", "labels", "demo", "consignment", "showroom"] },
    ],
  },
  {
    label: "Messaging",
    area: "workspace",
    description: "Email accounts and templates, signature banners, the help desk and connected channels.",
    items: [
      { key: "email", label: "Email", keywords: ["smtp", "imap", "templates"] },
      // Owner-only (no `permission`, not `everyone`): mirrors the page and its actions' requireTenantOwner().
      { key: "signature-banners", label: "Signature banners", href: "/settings/signature-banners", keywords: ["signature", "banner", "marketing", "promotion", "campaign", "email footer", "rocketseed", "advert", "special"] },
      { key: "helpdesk", label: "Help desk", href: "/settings/helpdesk", permission: "cases.manage", module: "support", keywords: ["mailboxes", "saved replies", "tags", "support", "tickets", "cases"] },
      {
        // ONE Integrations page (batch 6) — it replaced the owner-only Settings tab
        // and "Integration overrides", whose old addresses both redirect here.
        key: "integrations",
        label: "Integrations",
        href: "/settings/integrations",
        // Visible to all signed-in users so tenant owners (who are not global
        // owners) can discover and navigate to this page. The page enforces
        // requireTenantOwner() — regular members who navigate here are redirected.
        everyone: true,
        keywords: ["api", "webhooks", "whatsapp", "meta", "email", "smtp", "imap", "telegram", "sms", "bulksms", "google reviews", "per-tenant", "credentials", "override", "ai", "elevenlabs", "chatgpt", "intake"],
      },
    ],
  },
  {
    label: "Documents & signing",
    area: "workspace",
    description: "Document templates, signing workflows and how signers are verified.",
    items: [
      { key: "documents", label: "Document Studio", href: "/document-studio", permission: ["document_templates.manage", "docbuilder.view", "docbuilder.manage"], keywords: ["documents", "templates", "document studio", "document builder"] },
      { key: "signing-workflows", label: "Signing workflows", href: "/settings/signing-workflows", keywords: ["approval", "signing", "workflow", "e-sign"] },
      { key: "signing-security", label: "Signing security", href: "/settings/signing-security", keywords: ["otp", "one-time code", "verify signer", "identity", "timestamp", "e-sign", "two factor"] },
    ],
  },
  {
    label: "Automation & AI",
    area: "workspace",
    description: "The assistant, automation rules, and every automatic job and message — with its switch.",
    items: [
      { key: "assistant", label: "Assistant", href: "/settings/assistant", module: "automation", keywords: ["ai", "assistant", "ask the crm", "personality", "tone", "chatgpt", "memory", "learning", "playbooks"] },
      { key: "automations", label: "Automations", module: "marketing", keywords: ["rules", "workflows", "triggers", "journeys", "follow-up", "next step"] },
      { key: "automatic", label: "Automatic jobs & messages", href: "/settings/automatic", keywords: ["automatic", "automation", "background", "cron", "reminders", "review requests", "surveys", "signed copies", "what runs", "switch off"] },
    ],
  },
  {
    label: "System",
    area: "admin",
    description: "Modules, security checks, backups, the error log and background queues.",
    items: [
      { key: "modules", label: "Modules", href: "/settings/modules", platform: true, keywords: ["features", "packs", "enable", "disable", "automotive", "workshop", "inbox", "add-ons"] },
      { key: "security", label: "Security checks", href: "/settings/security", platform: true, keywords: ["security", "security checks", "surface exposure"] },
      { key: "backups", label: "Backup & recovery", href: "/settings/backup-recovery", platform: true, keywords: ["backup", "restore", "disaster recovery"] },
      { key: "system", label: "System Log", keywords: ["errors", "logs", "diagnostics"] },
      { key: "queues", label: "Background queues", href: "/settings/queues", keywords: ["queue", "jobs", "outbox", "failed", "stuck", "worker", "signing jobs", "campaign sends", "journeys"] },
    ],
  },
];

/** The groups under each area heading, in order — empty areas dropped. */
export function settingsByArea(groups: SettingsNavGroup[]): Array<{ area: (typeof SETTINGS_AREAS)[number]; groups: SettingsNavGroup[] }> {
  return SETTINGS_AREAS.map((area) => ({ area, groups: groups.filter((group) => group.area === area.key) })).filter((entry) => entry.groups.length > 0);
}

/** A group picked in the tablet/phone picker, and the section it was picked on. */
export type SettingsPickerChoice = { section: string; group: string } | null;

/**
 * The group the tablet/phone picker shows (review of #1076): the one you just
 * picked, while you are still on the section you picked it on; otherwise the
 * group holding the section you are on. Navigating between sections without a
 * remount (/settings?tab=…) used to leave the old group showing.
 */
export function pickerGroupLabel(groups: SettingsNavGroup[], current: string, choice: SettingsPickerChoice): string {
  if (choice && choice.section === current) return choice.group;
  return groups.find((group) => group.items.some((item) => item.key === current))?.label ?? "";
}

export const SETTINGS_TABS = SETTINGS_NAV_GROUPS.flatMap((group) => group.items);

export function settingsHref(item: SettingsNavItem) {
  return item.href ?? `/settings?tab=${encodeURIComponent(item.key)}`;
}

/**
 * A settings surface is enabled when it isn't tied to a feature pack, or its
 * pack is in the enabled set. `enabled === undefined` means "don't filter"
 * (module gating unknown in this context) so everything shows.
 */
export function settingsItemEnabled(
  item: SettingsNavItem,
  enabled?: ReadonlySet<string>,
): boolean {
  if (!item.module || !enabled) return true;
  return enabled.has(item.module);
}

/**
 * `isOwner` is the owner of the WORKSPACE being viewed (requireTenantOwner);
 * `isPlatformOwner` is the platform-wide owner role (requireOwner), the only
 * viewer of `platform` entries.
 */
export type SettingsViewer = { isOwner: boolean; isPlatformOwner?: boolean; permissions: readonly string[] };

/**
 * THE one rule for which settings entries a person is shown — the sidebar menu,
 * the ⌘K palette, search, /settings and every settings page's own side nav all
 * ask this. They used to disagree: the menu honoured `permission`, everything
 * else showed non-owners only My Account (hiding pages they're allowed to use)
 * or showed everyone everything (advertising pages that redirect them away).
 */
export function canSeeSettingsItem(item: SettingsNavItem, viewer: SettingsViewer): boolean {
  if (item.platform) return viewer.isPlatformOwner === true;
  if (viewer.isOwner || item.everyone) return true;
  if (!item.permission) return false;
  const need = Array.isArray(item.permission) ? item.permission : [item.permission];
  return need.some((permission) => viewer.permissions.includes(permission));
}

export function visibleSettingsGroups(
  viewer: SettingsViewer,
  enabled?: ReadonlySet<string>,
  groups: SettingsNavGroup[] = SETTINGS_NAV_GROUPS,
): SettingsNavGroup[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => canSeeSettingsItem(item, viewer) && settingsItemEnabled(item, enabled)),
    }))
    .filter((group) => group.items.length > 0);
}

// Aliases used by the visual-consistency components (SettingsNav / search).
export const settingsDestination = settingsHref;
export type SettingsGroup = SettingsNavGroup;

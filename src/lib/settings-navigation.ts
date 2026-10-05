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

export type SettingsNavGroup = {
  label: string;
  items: SettingsNavItem[];
};

/** Shared source of truth for the settings page and application search. */
export const SETTINGS_NAV_GROUPS: SettingsNavGroup[] = [
  {
    label: "Workspace",
    items: [
      { key: "overview", label: "Settings overview", keywords: ["home", "all settings", "configuration"] },
    ],
  },
  {
    label: "Personal",
    items: [
      { key: "account", label: "My Account", everyone: true, keywords: ["profile", "name", "email", "phone", "photo", "job title", "password", "signature"] },
      { key: "notifications", label: "Notifications", keywords: ["alerts", "push", "email preferences"] },
    ],
  },
  {
    label: "Organisation",
    items: [
      { key: "company", label: "Company profile", href: "/settings/company", keywords: ["business", "address", "phone", "branding", "footer", "logo", "details"] },
      { key: "modules", label: "Modules", href: "/settings/modules", platform: true, keywords: ["features", "packs", "enable", "disable", "automotive", "workshop", "inbox", "add-ons"] },
      { key: "assistant", label: "Assistant", href: "/settings/assistant", module: "automation", keywords: ["ai", "assistant", "ask the crm", "personality", "tone", "chatgpt", "memory", "learning", "playbooks"] },
      { key: "custom-fields", label: "Custom fields", href: "/settings/custom-fields", keywords: ["custom", "fields", "eav", "extra", "attributes", "metadata", "contact fields", "lead fields", "properties"] },
      // Beside custom fields rather than under Operations: both decide what gets
      // recorded against a record, and a checklist is not tied to one module —
      // it configures deliveries, workshop check-ins and vehicle condition
      // reports from one screen. The permission mirrors the page's own guard,
      // which mirrors the action's, so the entry cannot advertise a screen the
      // viewer would be redirected away from.
      { key: "checklists", label: "Checklists", href: "/settings/checklists", permission: "document_templates.manage", keywords: ["checklist", "checklists", "handover", "inspection", "photos", "capture", "steps", "delivery", "check-in", "condition report"] },
      { key: "clock-weather", label: "Clock & weather", href: "/settings/clock-weather", keywords: ["clock", "time", "weather", "cities", "timezone", "city", "temperature"] },
    ],
  },
  {
    label: "Sales & CRM",
    items: [
      { key: "pipeline", label: "Pipeline", href: "/settings/pipelines", permission: "pipelines.manage", keywords: ["lead stages", "sales stages"] },
      { key: "activity-types", label: "Activity types", href: "/settings/activity-types", keywords: ["activity", "activities", "types", "task", "tasks", "diary", "calendar", "meeting", "call", "test drive", "golf day", "custom type", "location"] },
      { key: "quotes", label: "Quotes", keywords: ["quote defaults", "terms"] },
      { key: "import", label: "Import", keywords: ["contacts", "csv", "upload"] },
    ],
  },
  {
    label: "Operations",
    items: [
      { key: "workshop", label: "Bookings & slots", module: "automotive", keywords: ["schedule", "calendar", "hours"] },
      { key: "workshop-settings", label: "Workshop settings", href: "/settings/workshop", permission: "workshop.manage", module: "automotive", keywords: ["bays", "labour rate", "packages", "workshop"] },
      { key: "products", label: "Products", module: "commerce", keywords: ["catalog", "pricing"] },
      { key: "stock", label: "Stock labels", module: "commerce", keywords: ["stock", "inventory", "labels", "demo", "consignment", "showroom"] },
    ],
  },
  {
    label: "Communications",
    items: [
      { key: "email", label: "Email", keywords: ["smtp", "imap", "templates"] },
      { key: "automations", label: "Automations", module: "marketing", keywords: ["rules", "workflows", "triggers", "journeys", "follow-up", "next step"] },
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
    label: "Documents & Data",
    items: [
      { key: "documents", label: "Document Studio", href: "/document-studio", permission: ["document_templates.manage", "docbuilder.view", "docbuilder.manage"], keywords: ["documents", "templates", "document studio", "document builder"] },
      { key: "signing-workflows", label: "Signing workflows", href: "/settings/signing-workflows", keywords: ["approval", "signing", "workflow", "e-sign"] },
      { key: "signing-security", label: "Signing security", href: "/settings/signing-security", keywords: ["otp", "one-time code", "verify signer", "identity", "timestamp", "e-sign", "two factor"] },
      { key: "backups", label: "Backup & recovery", href: "/settings/backup-recovery", platform: true, keywords: ["backup", "restore", "disaster recovery"] },
    ],
  },
  {
    label: "Security & Access",
    items: [
      { key: "team", label: "Team & access", href: "/settings/access", permission: ["teams.view", "roles.view", "teams.manage", "roles.manage"], keywords: ["users", "staff", "members", "roles", "permissions"] },
      { key: "portal-access", label: "Portal access", href: "/settings/portal-access", permission: "portal_access.manage", keywords: ["customer portal", "delegation", "profile requests"] },
      { key: "security", label: "Security", href: "/settings/security", platform: true, keywords: ["security checks", "surface exposure"] },
      { key: "sessions", label: "Sessions & devices", href: "/settings/sessions", keywords: ["devices", "logins", "sign out"] },
    ],
  },
  {
    label: "System",
    items: [
      { key: "system", label: "System Log", keywords: ["errors", "logs", "diagnostics"] },
      { key: "queues", label: "Background queues", href: "/settings/queues", keywords: ["queue", "jobs", "outbox", "failed", "stuck", "worker", "signing jobs", "campaign sends", "journeys"] },
    ],
  },
];

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

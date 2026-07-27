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
      { key: "modules", label: "Modules", href: "/settings/modules", keywords: ["features", "packs", "enable", "disable", "automotive", "workshop", "inbox", "add-ons"] },
      { key: "custom-fields", label: "Custom fields", href: "/settings/custom-fields", keywords: ["custom", "fields", "eav", "extra", "attributes", "metadata", "contact fields", "lead fields", "properties"] },
    ],
  },
  {
    label: "Sales & CRM",
    items: [
      { key: "pipeline", label: "Pipeline", href: "/settings/pipelines", permission: "pipelines.manage", keywords: ["lead stages", "sales stages"] },
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
      { key: "automations", label: "Automations", module: "marketing", keywords: ["rules", "workflows", "triggers"] },
      { key: "helpdesk", label: "Help desk", href: "/settings/helpdesk", permission: "cases.manage", module: "support", keywords: ["mailboxes", "saved replies", "tags", "support", "tickets", "cases"] },
      { key: "integrations", label: "Integrations", keywords: ["api", "webhooks", "whatsapp", "meta"] },
      {
        key: "integration-overrides",
        label: "Integration overrides",
        href: "/settings/integration-overrides",
        keywords: ["whatsapp", "email", "smtp", "imap", "telegram", "sms", "bulksms", "google reviews", "per-tenant", "credentials", "override"],
      },
    ],
  },
  {
    label: "Documents & Data",
    items: [
      { key: "documents", label: "Documents", href: "/settings/documents", keywords: ["templates", "document studio"] },
      { key: "signing-workflows", label: "Signing workflows", href: "/settings/signing-workflows", keywords: ["approval", "signing", "workflow", "e-sign"] },
      { key: "backups", label: "Backup & recovery", href: "/settings/backup-recovery", keywords: ["backup", "restore", "disaster recovery"] },
    ],
  },
  {
    label: "Security & Access",
    items: [
      { key: "team", label: "Team & access", href: "/settings/access", permission: ["teams.view", "roles.view", "teams.manage", "roles.manage"], keywords: ["users", "staff", "members", "roles", "permissions"] },
      { key: "portal-access", label: "Portal access", href: "/settings/portal-access", permission: "portal_access.manage", keywords: ["customer portal", "delegation", "profile requests"] },
      { key: "security", label: "Security", href: "/settings/security", keywords: ["security checks", "surface exposure"] },
      { key: "sessions", label: "Sessions & devices", href: "/settings/sessions", keywords: ["devices", "logins", "sign out"] },
    ],
  },
  {
    label: "System",
    items: [
      { key: "system", label: "System Log", keywords: ["errors", "logs", "diagnostics"] },
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

// Aliases used by the visual-consistency components (SettingsNav / search).
export const settingsDestination = settingsHref;
export type SettingsGroup = SettingsNavGroup;

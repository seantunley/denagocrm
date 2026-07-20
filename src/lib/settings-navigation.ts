export type SettingsNavItem = {
  key: string;
  label: string;
  href?: string;
  keywords?: string[];
  /** Visible to every signed-in user (e.g. their own account), not just owners. */
  everyone?: boolean;
  /** Visible to owners, or to non-owners holding this permission (or any of them). Mirrors the page's own guard. */
  permission?: string | string[];
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
      { key: "modules", label: "Modules", href: "/settings/modules", keywords: ["features", "packs", "enable", "disable", "automotive", "workshop", "inbox", "add-ons"] },
    ],
  },
  {
    label: "You",
    items: [
      { key: "account", label: "My Account", everyone: true, keywords: ["profile", "password", "signature"] },
      { key: "notifications", label: "Notifications", keywords: ["alerts", "push", "email preferences"] },
    ],
  },
  {
    label: "CRM",
    items: [
      { key: "pipeline", label: "Pipeline", href: "/settings/pipelines", permission: "pipelines.manage", keywords: ["lead stages", "sales stages"] },
      { key: "quotes", label: "Quotes", keywords: ["quote defaults", "terms"] },
      { key: "import", label: "Import", keywords: ["contacts", "csv", "upload"] },
    ],
  },
  {
    label: "Workshop",
    items: [
      { key: "workshop", label: "Bookings & slots", keywords: ["schedule", "calendar", "hours"] },
      { key: "workshop-settings", label: "Workshop settings", href: "/settings/workshop", permission: "workshop.manage", keywords: ["bays", "labour rate", "packages", "workshop"] },
    ],
  },
  {
    label: "Catalog",
    items: [
      { key: "products", label: "Products", keywords: ["catalog", "pricing"] },
      { key: "stock", label: "Stock labels", keywords: ["stock", "inventory", "labels", "demo", "consignment", "showroom"] },
    ],
  },
  {
    label: "Comms & Marketing",
    items: [
      { key: "email", label: "Email", keywords: ["smtp", "imap", "templates"] },
      { key: "automations", label: "Automations", keywords: ["rules", "workflows", "triggers"] },
      { key: "helpdesk", label: "Help desk", href: "/settings/helpdesk", permission: "cases.manage", keywords: ["mailboxes", "saved replies", "tags", "support", "tickets", "cases"] },
    ],
  },
  {
    label: "Organisation",
    items: [
      { key: "company", label: "Company profile", href: "/settings/company", keywords: ["business", "address", "phone", "branding", "footer", "logo", "details"] },
      { key: "team", label: "Team & access", href: "/settings/access", permission: ["teams.view", "roles.view", "teams.manage", "roles.manage"], keywords: ["users", "staff", "members", "roles", "permissions"] },
      { key: "portal-access", label: "Portal access", href: "/settings/portal-access", permission: "portal_access.manage", keywords: ["customer portal", "delegation", "profile requests"] },
      { key: "documents", label: "Documents", href: "/settings/documents", keywords: ["templates", "document studio"] },
      { key: "signing-workflows", label: "Signing workflows", href: "/settings/signing-workflows", keywords: ["approval", "signing", "workflow", "e-sign"] },
      { key: "security", label: "Security", href: "/settings/security", keywords: ["security checks", "surface exposure"] },
      { key: "backups", label: "Backup & recovery", href: "/settings/backup-recovery", keywords: ["backup", "restore", "disaster recovery"] },
      { key: "sessions", label: "Sessions & devices", href: "/settings/sessions", keywords: ["devices", "logins", "sign out"] },
      { key: "integrations", label: "Integrations", keywords: ["api", "webhooks", "whatsapp", "meta"] },
      { key: "system", label: "System Log", keywords: ["errors", "logs", "diagnostics"] },
    ],
  },
];

export const SETTINGS_TABS = SETTINGS_NAV_GROUPS.flatMap((group) => group.items);

export function settingsHref(item: SettingsNavItem) {
  return item.href ?? `/settings?tab=${encodeURIComponent(item.key)}`;
}

// Aliases used by the visual-consistency components (SettingsNav / search).
export const settingsDestination = settingsHref;
export type SettingsGroup = SettingsNavGroup;

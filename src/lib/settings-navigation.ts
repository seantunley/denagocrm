export type SettingsNavItem = {
  key: string;
  label: string;
  href?: string;
  keywords?: string[];
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
    label: "You",
    items: [
      { key: "account", label: "My Account", keywords: ["profile", "password", "signature"] },
      { key: "notifications", label: "Notifications", keywords: ["alerts", "push", "email preferences"] },
    ],
  },
  {
    label: "CRM",
    items: [
      { key: "pipeline", label: "Pipeline", href: "/settings/pipelines", keywords: ["lead stages", "sales stages"] },
      { key: "quotes", label: "Quotes", keywords: ["quote defaults", "terms"] },
      { key: "import", label: "Import", keywords: ["contacts", "csv", "upload"] },
    ],
  },
  {
    label: "Workshop",
    items: [
      { key: "workshop", label: "Bookings & slots", keywords: ["schedule", "calendar", "hours"] },
    ],
  },
  {
    label: "Catalog",
    items: [
      { key: "products", label: "Products", keywords: ["catalog", "pricing"] },
      { key: "library", label: "Library", keywords: ["document library", "files", "attachments"] },
    ],
  },
  {
    label: "Comms & Marketing",
    items: [
      { key: "email", label: "Email", keywords: ["smtp", "imap", "templates"] },
      { key: "automations", label: "Automations", keywords: ["rules", "workflows", "triggers"] },
    ],
  },
  {
    label: "Organisation",
    items: [
      { key: "team", label: "Team & access", href: "/settings/access", keywords: ["users", "staff", "members", "roles", "permissions"] },
      { key: "portal-access", label: "Portal access", href: "/settings/portal-access", keywords: ["customer portal", "delegation", "profile requests"] },
      { key: "helpdesk", label: "Help desk", href: "/settings/helpdesk", keywords: ["support", "mailboxes", "saved replies", "ticket tags"] },
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

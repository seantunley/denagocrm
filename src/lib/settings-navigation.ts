export type SettingsItem = {
  key: string;
  label: string;
  href?: string;
  keywords?: string[];
};

export type SettingsGroup = { label: string; items: SettingsItem[] };

export const SETTINGS_NAV_GROUPS: SettingsGroup[] = [
  {
    label: "You",
    items: [
      { key: "account", label: "My Account", keywords: ["profile", "password", "signature"] },
      { key: "notifications", label: "Notifications", keywords: ["alerts", "push"] },
    ],
  },
  {
    label: "CRM",
    items: [
      { key: "pipeline", label: "Pipeline", keywords: ["sales", "stages"] },
      { key: "quotes", label: "Quotes", keywords: ["defaults", "terms", "tax"] },
      { key: "import", label: "Import", keywords: ["contacts", "csv"] },
    ],
  },
  {
    label: "Workshop",
    items: [
      { key: "workshop", label: "Bookings & slots", keywords: ["calendar", "hours", "capacity"] },
    ],
  },
  {
    label: "Catalog",
    items: [
      { key: "products", label: "Products", href: "/products", keywords: ["catalog", "pricing"] },
      {
        key: "library",
        label: "Library",
        href: "/library",
        keywords: ["files", "brochures", "price lists", "documents"],
      },
    ],
  },
  {
    label: "Comms & Marketing",
    items: [
      { key: "email", label: "Email", keywords: ["smtp", "imap", "templates"] },
      { key: "automations", label: "Automations", href: "/automations", keywords: ["workflows"] },
    ],
  },
  {
    label: "Organisation",
    items: [
      { key: "team", label: "Team", keywords: ["users", "staff"] },
      {
        key: "documents",
        label: "Documents",
        href: "/settings/documents",
        keywords: ["document studio", "templates", "indemnity", "quote templates"],
      },
      { key: "security", label: "Security", href: "/settings/security", keywords: ["checks", "audit"] },
      {
        key: "backups",
        label: "Backup & recovery",
        href: "/settings/backup-recovery",
        keywords: ["restore", "database", "disaster recovery"],
      },
      {
        key: "sessions",
        label: "Sessions & devices",
        href: "/settings/sessions",
        keywords: ["login", "devices", "sign out"],
      },
      { key: "integrations", label: "Integrations", keywords: ["api", "webhooks", "whatsapp", "meta"] },
      { key: "system", label: "System Log", keywords: ["errors", "health", "diagnostics"] },
    ],
  },
];

export const SETTINGS_NAV_ITEMS = SETTINGS_NAV_GROUPS.flatMap((group) => group.items);

export function settingsDestination(item: SettingsItem) {
  return item.href ?? `/settings?tab=${item.key}`;
}

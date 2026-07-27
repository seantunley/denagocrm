// Pure metadata for the 7 outbound integrations a tenant may override its own
// credential for (see resolveTenantCredential/putTenantCredential in
// ./settings.ts). Deliberately free of server/db imports so it's shared,
// unit-testable, by both the "use server" actions file
// (src/app/actions/tenantCredentials.ts) and the settings page — mirrors how
// settingsSecrets.ts stays a plain module the "use server" settings.ts
// actions import from.

export type TenantCredentialField = {
  /** Same key namespace as AppSetting / TenantIntegrationCredential.key. */
  key: string;
  label: string;
  /** Shown when no override is set yet (mirrors the global settings page's per-field hints). */
  placeholder: string;
};

export type TenantCredentialIntegration = {
  id: string;
  label: string;
  description: string;
  fields: TenantCredentialField[];
};

export const TENANT_CREDENTIAL_INTEGRATIONS: readonly TenantCredentialIntegration[] = [
  {
    id: "whatsapp",
    label: "WhatsApp Business (Cloud API)",
    description:
      "Send and receive WhatsApp messages through this tenant's own WhatsApp number instead of the platform's shared one.",
    fields: [
      { key: "WA_PHONE_NUMBER_ID", label: "Phone number ID", placeholder: "From WhatsApp → API Setup" },
      { key: "WA_ACCESS_TOKEN", label: "Access token (permanent, System User)", placeholder: "EAAG…" },
    ],
  },
  {
    id: "meta",
    label: "Meta (Messenger & Instagram)",
    description:
      "Route Messenger and Instagram DMs through this tenant's own Meta page instead of the platform's shared page.",
    fields: [
      { key: "META_PAGE_ACCESS_TOKEN", label: "Page access token (System User)", placeholder: "EAAG…" },
    ],
  },
  {
    id: "telegram",
    label: "Telegram",
    description:
      "Run the Telegram bot under this tenant's own bot token instead of the platform's shared bot.",
    fields: [
      { key: "TELEGRAM_BOT_TOKEN", label: "Bot token", placeholder: "123456789:AA…" },
    ],
  },
  {
    id: "smtp",
    label: "Outbound email (SMTP)",
    description:
      "Send emails from this tenant's own mail server instead of the platform's shared one.",
    fields: [
      { key: "SMTP_HOST", label: "Host", placeholder: "mail.example.com" },
      { key: "SMTP_PORT", label: "Port", placeholder: "587" },
      { key: "SMTP_SECURE", label: "Encryption", placeholder: "" },
      { key: "SMTP_USER", label: "Username", placeholder: "user@example.com" },
      { key: "SMTP_PASS", label: "Password", placeholder: "Shown once when created" },
      { key: "SMTP_FROM", label: "From address", placeholder: "noreply@example.com" },
    ],
  },
  {
    id: "imap",
    label: "Inbound email (IMAP)",
    description:
      "Read incoming email from this tenant's own mailbox instead of the platform's shared one.",
    fields: [
      { key: "IMAP_HOST", label: "Host", placeholder: "mail.example.com" },
      { key: "IMAP_PORT", label: "Port", placeholder: "993" },
      { key: "IMAP_SECURE", label: "Encryption", placeholder: "" },
      { key: "IMAP_USER", label: "Username", placeholder: "user@example.com" },
      { key: "IMAP_PASS", label: "Password", placeholder: "Shown once when created" },
    ],
  },
  {
    id: "sms",
    label: "SMS one-time codes (BulkSMS)",
    description:
      "Send OTP codes through this tenant's own BulkSMS account instead of the platform's shared one.",
    fields: [
      { key: "BULKSMS_TOKEN_ID", label: "Token ID", placeholder: "From BulkSMS → API Tokens" },
      { key: "BULKSMS_TOKEN_SECRET", label: "Token secret", placeholder: "Shown once when the token is created" },
    ],
  },
  {
    id: "google-reviews",
    label: "Google reviews",
    description:
      "Pull reviews for this tenant's own Google Business listing instead of the platform's shared one.",
    fields: [
      { key: "GOOGLE_PLACES_API_KEY", label: "Places API key", placeholder: "AIza…" },
      { key: "GOOGLE_PLACE_ID", label: "Place ID", placeholder: "ChIJ…" },
    ],
  },
] as const;

export const TENANT_CREDENTIAL_KEYS: ReadonlySet<string> = new Set(
  TENANT_CREDENTIAL_INTEGRATIONS.flatMap((integration) => integration.fields.map((field) => field.key)),
);

export function isKnownTenantCredentialKey(key: string): boolean {
  return TENANT_CREDENTIAL_KEYS.has(key);
}

/**
 * SMTP_SECURE/IMAP_SECURE are stored as the strings "true"/"false" (see
 * src/lib/email.ts, src/lib/imapSync.ts), not free text — render them as a
 * tri-state select (blank = "leave unchanged") instead of a text/password input.
 */
const BOOLEAN_FIELD_KEYS: ReadonlySet<string> = new Set(["SMTP_SECURE", "IMAP_SECURE"]);

export function isBooleanTenantCredentialField(key: string): boolean {
  return BOOLEAN_FIELD_KEYS.has(key);
}

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
  /**
   * Whether this field must be present for the integration bundle to be
   * considered complete. Defaults to true. Optional fields (e.g. SMTP_SECURE)
   * may remain at the platform default even when the rest of the bundle is
   * tenant-overridden without making the bundle "incomplete".
   */
  required?: boolean;
  /**
   * Resolved on its own, not as part of the set: this workspace's saved value is
   * used whenever it has one, even while the set's required fields still come
   * from the platform default. For values that belong to the workspace whichever
   * app they run through — X's sign-in tokens (the OAuth callback writes them per
   * workspace) and its Grok settings. Never for a field that has to match the
   * rest of the set, like a password for a username. Implies not required.
   */
  independent?: boolean;
};

export type TenantCredentialIntegration = {
  id: string;
  label: string;
  description: string;
  fields: TenantCredentialField[];
};

export const TENANT_CREDENTIAL_INTEGRATIONS: readonly TenantCredentialIntegration[] = [
  {
    id: "x",
    label: "X",
    description: "Receive X DMs, mentions and replies, reply from the inbox, and create CRM leads for this tenant.",
    fields: [
      { key: "X_CLIENT_ID", label: "OAuth 2 client ID", placeholder: "From X Developer Portal" },
      { key: "X_CLIENT_SECRET", label: "OAuth 2 client secret", placeholder: "Shown once in X Developer Portal" },
      { key: "X_WEBHOOK_SECRET", label: "Webhook signing secret", placeholder: "X app consumer secret" },
      // The X APP is the set above: client id, client secret and webhook secret
      // must all come from one place, or OAuth signs with a mismatched pair.
      // The connected ACCOUNT's tokens and the Grok settings are the workspace's
      // own however that app is configured, so they resolve independently.
      { key: "X_ACCOUNT_ID", label: "Connected X account ID", placeholder: "Filled by OAuth", required: false, independent: true },
      { key: "X_USERNAME", label: "Connected @username", placeholder: "Filled by OAuth", required: false, independent: true },
      { key: "X_ACCESS_TOKEN", label: "Access token", placeholder: "Filled by OAuth", required: false, independent: true },
      { key: "X_REFRESH_TOKEN", label: "Refresh token", placeholder: "Filled by OAuth", required: false, independent: true },
      { key: "XAI_API_KEY", label: "Grok API key (optional)", placeholder: "xai-…", required: false, independent: true },
      { key: "XAI_MODEL", label: "Grok model", placeholder: "grok-4.6", required: false, independent: true },
      { key: "XAI_DRAFTS_ENABLED", label: "Allow Grok reply drafts", placeholder: "false", required: false, independent: true },
    ],
  },
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
  /*
   * TELEGRAM IS DELIBERATELY NOT HERE.
   *
   * It was, and the entry could not work. Storing a bot token as an override
   * puts it in `TenantIntegrationCredential`, but an inbound Telegram update
   * carries no id for OUR bot — `resolveTelegramTenant` identifies the workspace
   * by matching the update's secret token against `TELEGRAM_WEBHOOK_SECRET` rows
   * in `AppSetting`. A token saved through this page therefore had no secret to
   * be found by, and no webhook was ever registered for it, so Telegram had
   * nowhere to deliver. The owner got a stored credential and a channel that
   * silently received nothing.
   *
   * Telegram is already per-tenant without this: `connectTelegram` writes both
   * the token AND the secret through `putSetting`, which scopes to the acting
   * workspace, and then calls setWebhook. That is the whole flow, and it lives
   * in Settings → Integrations with the other customer channels.
   */
  {
    id: "smtp",
    label: "Outbound email (SMTP)",
    description:
      "Send emails from this tenant's own mail server instead of the platform's shared one.",
    fields: [
      { key: "SMTP_HOST", label: "Host", placeholder: "mail.example.com" },
      { key: "SMTP_PORT", label: "Port", placeholder: "587" },
      { key: "SMTP_SECURE", label: "Encryption", placeholder: "", required: false },
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
      { key: "IMAP_SECURE", label: "Encryption", placeholder: "", required: false },
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
 * Returns the bundle status for an integration given a per-key override map.
 *  - "active"     — every required field has a tenant override
 *  - "incomplete" — at least one field has an override but at least one
 *                   required field does not; the bundle will partially mix
 *                   tenant and platform credentials at runtime
 *  - "default"    — no field has an override
 */
export function integrationOverrideStatus(
  integration: TenantCredentialIntegration,
  hasOverride: Record<string, boolean>,
): "active" | "incomplete" | "default" {
  // Independent fields (X's sign-in tokens, Grok) do not make the SET partial:
  // they are in use on their own, whichever place the set comes from.
  const anyOverride = integration.fields.some((f) => !f.independent && hasOverride[f.key]);
  if (!anyOverride) return "default";
  const allRequiredOverridden = integration.fields
    .filter((f) => f.required !== false && !f.independent)
    .every((f) => hasOverride[f.key]);
  return allRequiredOverridden ? "active" : "incomplete";
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

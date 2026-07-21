// Pure helpers + allowlists for owner-only secret management. Deliberately free
// of server imports ("use server", next/cache, db) so they're unit-testable and
// shared by the settings server actions and the client controls.

/**
 * Secret settings an owner-only action may REVEAL or CLEAR. A server action's
 * bound key arrives from the client, so it MUST be validated against this list —
 * never trust it to reference an arbitrary AppSetting row.
 */
export const MANAGED_SECRET_KEYS: ReadonlySet<string> = new Set([
  "SMTP_PASS",
  "IMAP_PASS",
  "META_PAGE_ACCESS_TOKEN",
  "META_APP_SECRET",
  "META_VERIFY_TOKEN",
  "WA_ACCESS_TOKEN",
  "GOOGLE_PLACES_API_KEY",
  "BULKSMS_TOKEN_SECRET",
  "ANTHROPIC_API_KEY",
  "INTAKE_API_KEY",
  "ELEVENLABS_API_KEY",
]);

/** Secrets WE generate (so regenerating them is safe). Externally-issued
 *  credentials (SMTP/IMAP passwords, provider tokens) are NOT regeneratable —
 *  overwriting them with random bytes would just break the integration. */
export const REGENERATABLE_KEYS: ReadonlySet<string> = new Set([
  "META_VERIFY_TOKEN",
  "INTAKE_API_KEY",
]);

export function isManagedSecret(key: string): boolean {
  return MANAGED_SECRET_KEYS.has(key);
}

export function isRegeneratable(key: string): boolean {
  return REGENERATABLE_KEYS.has(key);
}

/**
 * Whether a saveSetting submit should be IGNORED (leave the stored value alone).
 * Secret fields render blank and pass keepIfBlank, so a blank submit means
 * "keep" (rotation only happens when a new value is typed); an explicit Clear
 * action is the separate, deliberate way to remove a secret.
 */
export function keepBlankSubmit(value: string, keepIfBlank: boolean): boolean {
  return value.length === 0 && keepIfBlank;
}

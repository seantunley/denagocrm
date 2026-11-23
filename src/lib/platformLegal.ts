/**
 * THE PLATFORM'S OWN IDENTITY — who runs the CRM as a product (Sean, 2026-11-21: "Lets call it Honeycomb 360", "lets use
 * crm.honeycombventures.co.za").
 *
 * The one shared Meta app (Connect Facebook, Connect WhatsApp) shows ONE name to every business on Meta's consent
 * screen, and Meta App Review requires a public privacy policy, terms and data-deletion page in that same name. These
 * pages (src/app/legal) say who the operator is — never a workspace's branding: Denago stays Denago.
 *
 * The company lines come from Sean's CIPC disclosure certificate (company name, registration number, registered office
 * only — never directors' personal details). If any is ever blanked, `companyComplete` is false and the pages show a
 * "Draft" notice instead of publishing blanks.
 */
export const PLATFORM = {
  name: "Honeycomb 360",
  domain: "crm.honeycombventures.co.za",
  /** The registered company that operates Honeycomb 360 — as on its CIPC certificate. */
  companyName: "Honeycomb Ventures (Pty) Ltd",
  registrationNumber: "2025/378969/07",
  /** The registered office (CIPC disclosure certificate, 11 September 2026). */
  address: "21 Winton Crescent, Woodbridge Island, Milnerton, Western Cape, 7441, South Africa",
  /** Where privacy and data-deletion requests go. */
  privacyEmail: "privacy@honeycombventures.co.za",
  /** The date the current wording took effect (shown on the pages). */
  effectiveDate: "21 November 2026",
} as const;

export const PLATFORM_URL = `https://${PLATFORM.domain}`;

/** True when a request's Host header is the platform's own address (any port, any case). */
export function isPlatformHost(host: string | null | undefined): boolean {
  return (host ?? "").trim().toLowerCase().split(":")[0] === PLATFORM.domain;
}

export function companyComplete(): boolean {
  return Boolean(PLATFORM.companyName && PLATFORM.registrationNumber && PLATFORM.address && PLATFORM.privacyEmail);
}

/** The status page Meta shows a person after a data-deletion request. */
export function dataDeletionStatusUrl(code: string): string {
  return `${PLATFORM_URL}/legal/data-deletion?code=${encodeURIComponent(code)}`;
}

// Marketing attribution forwarded by the website with each intake lead
// (denagocpt lib/attribution.ts). It arrives inside the lead's raw intake
// JSON under `attribution`; this parses it back out for display and for the
// Google Ads offline-conversion export.

const ATTRIBUTION_KEYS = [
  "gclid",
  "gbraid",
  "wbraid",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "landingPage",
  "referrer",
  "capturedAt",
] as const;

export type LeadAttribution = Partial<Record<(typeof ATTRIBUTION_KEYS)[number], string>>;

/** Parses attribution out of a lead's raw intake payload. Null if absent. */
export function leadAttribution(raw: string | null): LeadAttribution | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const attribution = parsed?.attribution;
    if (!attribution || typeof attribution !== "object") return null;
    const out: LeadAttribution = {};
    for (const key of ATTRIBUTION_KEYS) {
      const value = attribution[key];
      if (typeof value === "string" && value.trim()) out[key] = value.trim();
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

/** True when the lead originated from a Google Ads click. */
export function isAdClick(attribution: LeadAttribution | null): boolean {
  return Boolean(attribution && (attribution.gclid || attribution.gbraid || attribution.wbraid));
}

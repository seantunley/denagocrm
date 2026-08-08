import net from "node:net";

/**
 * Which hosts headless Chromium may load a subresource from while rendering an
 * untrusted template.
 *
 * Its own module, with no `server-only` import, so the rules are unit-testable —
 * customDocs.ts cannot be loaded from a test at all.
 *
 * This replaces a DENYLIST of private ranges, which could not work. Two reasons,
 * both demonstrated against the old function in the test suite:
 *
 *  - It matched on the HOSTNAME STRING, and DNS is resolved by Chromium
 *    afterwards. A name that A-records to 169.254.169.254 sailed through, as did
 *    metadata.google.internal. No amount of regex fixes that.
 *  - Even as a string matcher it missed every alternative IP encoding —
 *    2852039166, 0xA9FEA9FE, 0251.0376.0251.0376 and [::ffff:169.254.169.254]
 *    are all 169.254.169.254 to Chromium and none matched. It also missed
 *    100.64.0.0/10 and fe80::, while wrongly blocking any public host beginning
 *    "fc"/"fd" (fda.example.com).
 *
 * An allowlist has no DNS problem, because the permitted NAMES are not
 * attacker-influenced. Templates are authored by docbuilder.manage holders and
 * their images are meant to be the company logo or an uploaded asset — verified
 * that no template in the database references any external image at all, so this
 * takes nothing away that is in use.
 */

/**
 * PDF_IMAGE_HOSTS entries, minus anything that would point the renderer back
 * INSIDE the network.
 *
 * The escape hatch is the weak point of an allowlist: it is trusted config, and
 * one careless entry ("localhost", an internal CDN, a bare IP) reopens exactly
 * what the allowlist closed. The shapes below can only ever be a mistake — a
 * public CDN is never an IP literal and never a `.internal` name — so they are
 * dropped rather than honoured.
 *
 * This does not remove the need for entries to be narrowly scoped. It removes
 * the failures that are unambiguous.
 */
export function configuredPdfImageHosts(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
    .filter((host) => {
      if (host.includes("*")) return false; // no wildcards — that is not scoping
      const bare = host.replace(/^\./, "");
      if (net.isIP(bare)) return false; // an IP literal is never a public CDN
      if (bare === "localhost" || bare.endsWith(".localhost")) return false;
      if (/\.(internal|local|lan|home|corp|intranet)$/.test(bare)) return false;
      if (!bare.includes(".")) return false; // single-label hosts are internal by definition
      return true;
    });
}

/** Whether Chromium may load from `hostname`, given the app origin and config. */
/**
 * `tenantHosts` are the VERIFIED tenant domains, passed in by the caller rather
 * than looked up here so this stays a pure function.
 *
 * Once a document logo URL is built from a tenant origin (lib/tenantOrigin.ts),
 * a renderer that only trusts NEXT_PUBLIC_APP_URL aborts the request and the PDF
 * is generated, stored and emailed with no logo — silently, because an aborted
 * image is not an error. Every one of these hostnames is the SAME deployment
 * under a different name, so trusting them widens nothing: any URL they can
 * serve, appHost could already serve.
 */
export function pdfImageHostAllowed(
  hostname: string,
  opts: { appUrl?: string; configured?: string; tenantHosts?: string[] } = {},
): boolean {
  const host = hostname.toLowerCase();
  let appHost = "crm.denagocpt.co.za";
  try {
    appHost = new URL(opts.appUrl || "https://crm.denagocpt.co.za").hostname;
  } catch {
    /* fall back to the literal above */
  }
  const allowed = [
    appHost, // our own origin (the logo and any /branding asset)
    ".blob.vercel-storage.com", // uploaded assets
    ...(opts.tenantHosts ?? []).map((h) => h.toLowerCase()),
    ...configuredPdfImageHosts(opts.configured),
  ];
  return allowed.some((entry) => (entry.startsWith(".") ? host.endsWith(entry) : host === entry));
}

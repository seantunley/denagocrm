/**
 * Nonce-based Content-Security-Policy, in two headers.
 *
 * ENFORCED — what is proven to work and closes the hole that mattered:
 *   script-src is nonce-gated with no 'unsafe-inline', so an injected <script>
 *   does not execute. That is the whole reason for the nonce.
 *
 * REPORT-ONLY — the resource directives (default-src / connect-src / img-src /
 *   font-src). These were briefly ENFORCED and that was a mistake: this app
 *   legitimately talks to Open-Meteo, the Google Maps JS API and Vercel Blob
 *   from the browser, and `connect-src 'self'` would have broken all three in
 *   production. The origins below are inventoried from source, but inventory is
 *   not the same as exercising them, so they report first.
 *
 * Promote by moving RESOURCE_DIRECTIVES into the enforced policy once a preview
 * deploy has been walked with the console open — the weather widget, an address
 * autocomplete, and a library upload are the three that matter.
 *
 * THAT PROMOTION NOW HAS EVIDENCE BEHIND IT. Both policies report to
 * `/api/csp-report`, which files each violation in the System Log. Until that
 * existed, "report-only" meant reported to NOBODY — a console line per visitor,
 * discarded — so the plan above depended on someone happening to walk the right
 * three pages with devtools open. An OWASP ZAP scan flagged the missing
 * resource directives as a real gap; it is right, and the sequence is collect,
 * read, then promote. Enforcing on inventory alone is what broke it last time.
 */
export type CspOptions = { nonce: string; dev: boolean };

/** Where both policies post violations. Kept next to the directives that name it. */
export const CSP_REPORT_PATH = "/api/csp-report";

/**
 * External origins the BROWSER reaches directly. Server-side fetches (Anthropic,
 * OpenAI, BulkSMS, Telegram, Meta Graph) are not subject to CSP and are not
 * listed — adding them would widen the policy for no reason.
 */
const OPEN_METEO = "https://api.open-meteo.com"; // ClockWeather, TestDriveWeather
const GOOGLE_MAPS = "https://maps.googleapis.com"; // LocationAutocomplete (Places)
const GOOGLE_STATIC = "https://maps.gstatic.com https://*.gstatic.com https://*.googleapis.com";
const GOOGLE_FONTS_CSS = "https://fonts.googleapis.com";
const GOOGLE_FONTS_FILES = "https://fonts.gstatic.com";
const VERCEL_BLOB = "https://*.vercel-storage.com"; // LibraryUploader uploads direct

/** Directives that govern where content may be LOADED FROM. Report-only for now. */
function resourceDirectives(): string[] {
  return [
    "default-src 'self'",
    `connect-src 'self' ${OPEN_METEO} ${GOOGLE_MAPS} ${VERCEL_BLOB}`,
    // data: for logos and signatures stamped into documents; blob: for the
    // signature pad's canvas capture.
    `img-src 'self' data: blob: ${GOOGLE_STATIC} ${VERCEL_BLOB}`,
    `font-src 'self' data: ${GOOGLE_FONTS_FILES}`,
  ];
}

/** Directives that are safe to enforce today. */
function enforcedDirectives({ nonce, dev }: CspOptions): string[] {
  return [
    // The XSS control. React uses eval in development to reconstruct server
    // error stacks; Next's own guidance is that production needs neither.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // Explicit, NOT left to fall back to script-src. CSP3 resolves worker-src
    // through child-src → script-src, and 'strict-dynamic' there would block
    // the PWA service worker at /sw.js, which no nonce can reach.
    "worker-src 'self'",
    // Stays permissive, deliberately. CSP governs React's style={{…}} props via
    // style-src-attr, which falls back to style-src — and there are ~205 of them
    // across 41 files, plus the signing surface and every print document
    // injecting a <style>. A nonce cannot cover a style ATTRIBUTE at all, so the
    // strict alternative is not "add a nonce", it is "rewrite 41 files". CSS
    // exfiltration is real but a far smaller prize than script execution.
    `style-src 'self' 'unsafe-inline' ${GOOGLE_FONTS_CSS}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    // The document studio previews our own print pages in an iframe.
    "frame-src 'self' blob:",
    "upgrade-insecure-requests",
    /*
     * WHERE VIOLATIONS GO. Without this, a Report-Only policy reports to nobody:
     * it writes a line to each visitor's console and is discarded, so the
     * question the report-only policy exists to answer — "would enforcing the
     * resource directives break anything?" — had no data behind it for months.
     *
     * Both spellings, deliberately. `report-uri` is deprecated and universally
     * implemented; `report-to` is current and needs the `Reporting-Endpoints`
     * response header (set in proxy.ts). A collector that speaks only one of
     * them silently loses the browsers that speak the other.
     *
     * Present on the ENFORCED policy too, not just report-only: a violation the
     * enforced policy actually blocked is the more urgent of the two, because
     * something on the site just failed to load for a real person.
     */
    `report-uri ${CSP_REPORT_PATH}`,
    "report-to csp-endpoint",
  ];
}

export function buildCsp(options: CspOptions): string {
  return enforcedDirectives(options).join("; ");
}

/**
 * Directives a browser IGNORES in a report-only policy, per CSP3 §3.1 — they
 * describe how to CHANGE a request, and report-only changes nothing.
 *
 * Sending them anyway is not harmful, just noisy, and Chromium says so on every
 * page load:
 *
 *   The Content Security Policy directive 'upgrade-insecure-requests' is
 *   ignored when delivered in a report-only policy.
 *
 * Found by actually opening the console on a deployed page, which is the only
 * way to find it — no test can see a header a browser silently drops. Worth
 * fixing because a console that cries wolf on every load is a console nobody
 * reads, and this policy exists precisely so its reports get read.
 *
 * All three remain in the ENFORCED policy, where they work.
 */
const IGNORED_IN_REPORT_ONLY = ["upgrade-insecure-requests", "frame-ancestors", "sandbox"];

/** The policy we intend to enforce next: everything above, plus the resource rules. */
export function buildCspReportOnly(options: CspOptions): string {
  return [...resourceDirectives(), ...enforcedDirectives(options)]
    .filter((directive) => !IGNORED_IN_REPORT_ONLY.includes(directive.split(/\s+/)[0]))
    .join("; ");
}

/**
 * A fresh nonce per request. `crypto.randomUUID()` is available on the Edge
 * runtime, where node:crypto is not — the proxy runs there.
 */
export function newCspNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}

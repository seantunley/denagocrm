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
 */
export type CspOptions = { nonce: string; dev: boolean };

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
  ];
}

export function buildCsp(options: CspOptions): string {
  return enforcedDirectives(options).join("; ");
}

/** The policy we intend to enforce next: everything above, plus the resource rules. */
export function buildCspReportOnly(options: CspOptions): string {
  return [...resourceDirectives(), ...enforcedDirectives(options)].join("; ");
}

/**
 * A fresh nonce per request. `crypto.randomUUID()` is available on the Edge
 * runtime, where node:crypto is not — the proxy runs there.
 */
export function newCspNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}

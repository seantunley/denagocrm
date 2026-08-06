/**
 * Nonce-based Content-Security-Policy. The main application keeps its broader
 * browser-resource inventory in report-only mode while the public signing and
 * approval surfaces use a separate fully enforced allowlist.
 */
export type CspOptions = { nonce: string; dev: boolean };

const OPEN_METEO = "https://api.open-meteo.com";
const GOOGLE_MAPS = "https://maps.googleapis.com";
const GOOGLE_STATIC = "https://maps.gstatic.com https://*.gstatic.com https://*.googleapis.com";
const GOOGLE_FONTS_CSS = "https://fonts.googleapis.com";
const GOOGLE_FONTS_FILES = "https://fonts.gstatic.com";
const VERCEL_BLOB = "https://*.vercel-storage.com";

function resourceDirectives(): string[] {
  return [
    "default-src 'self'",
    `connect-src 'self' ${OPEN_METEO} ${GOOGLE_MAPS} ${VERCEL_BLOB}`,
    `img-src 'self' data: blob: ${GOOGLE_STATIC} ${VERCEL_BLOB}`,
    `font-src 'self' data: ${GOOGLE_FONTS_FILES}`,
  ];
}

function enforcedDirectives({ nonce, dev }: CspOptions): string[] {
  return [
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "worker-src 'self'",
    // Stays permissive, deliberately: React style attributes and exact-position
    // signing overlays cannot be covered by a script nonce without a UI rewrite.
    `style-src 'self' 'unsafe-inline' ${GOOGLE_FONTS_CSS}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    "frame-src 'self' blob:",
    "upgrade-insecure-requests",
  ];
}

export function buildCsp(options: CspOptions): string {
  return enforcedDirectives(options).join("; ");
}

/**
 * Public signing/approval pages do not need weather, Maps, public Blob, third-
 * party fonts, workers or framing. Enforce the complete resource policy there,
 * not merely script-src. Inline styles remain because the signing document and
 * exact-position field overlays are rendered from style attributes; script is
 * still nonce-gated and no outside network origin is permitted.
 */
export function buildPublicSigningCsp({ nonce, dev }: CspOptions): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "connect-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "media-src 'none'",
    "manifest-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

const IGNORED_IN_REPORT_ONLY = ["upgrade-insecure-requests", "frame-ancestors", "sandbox"];

export function buildCspReportOnly(options: CspOptions): string {
  return [...resourceDirectives(), ...enforcedDirectives(options)]
    .filter((directive) => !IGNORED_IN_REPORT_ONLY.includes(directive.split(/\s+/)[0]))
    .join("; ");
}

export function newCspNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}

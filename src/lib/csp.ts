/**
 * Nonce-based Content-Security-Policy.
 *
 * The previous policy kept `'unsafe-inline'` in script-src, because Next inlines
 * its hydration bootstrap — which meant the CSP could not stop an injected
 * script, only stop it phoning home. A per-request nonce closes that: Next
 * stamps the nonce onto its own scripts, the browser runs those, and an
 * injected `<script>` without the nonce does not execute.
 *
 * Two deliberate relaxations, both load-bearing:
 *
 * `style-src 'unsafe-inline'` stays. CSP governs React's `style={{…}}` props
 * through style-src-attr, which falls back to style-src — and there are ~205 of
 * them across 41 files here, plus the signing surface and every print document
 * injecting a `<style>` block. Nonces cannot cover a style ATTRIBUTE at all, so
 * the strict alternative is not "add a nonce", it is "rewrite 41 files". The
 * trade is worth naming: CSS-based exfiltration of attribute values is a real
 * technique, but it is a far smaller prize than script execution, which is what
 * this now blocks.
 *
 * `'strict-dynamic'` lets a nonced script load further scripts — Next's runtime
 * loads chunks that way, so without it the app boots and then dies. It also
 * means host allowlists in script-src are IGNORED by supporting browsers; the
 * nonce is the whole gate. That is the intent.
 */
export type CspOptions = { nonce: string; dev: boolean };

export function buildCsp({ nonce, dev }: CspOptions): string {
  return [
    "default-src 'self'",
    // React uses eval in development to reconstruct server error stacks. Next's
    // own guidance: required in dev, never in production.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // See the note above — this is the one directive that stays permissive.
    "style-src 'self' 'unsafe-inline'",
    // data: for logos and signature images stamped into documents; blob: for the
    // signature pad's canvas capture.
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    // The document studio previews our own print pages in an iframe.
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
}

/**
 * A fresh nonce per request. `crypto.randomUUID()` is available on the Edge
 * runtime, where node:crypto is not — the proxy runs there.
 */
export function newCspNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}

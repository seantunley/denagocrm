/**
 * One HTML encoder, safe in both text and quoted-attribute positions.
 *
 * There were two private copies of this and a third surface with none, which is
 * how the tenant display name ended up interpolated raw into an `alt="…"`, into
 * a footer, and into a sentence in every outgoing campaign email. A name
 * containing a quote or a tag could change the markup of mail sent to that
 * tenant's customers.
 *
 * The five characters below are what make a single function sufficient for both
 * contexts: `&<>` cover element content, and `"'` cover an attribute value
 * however it is quoted. Splitting text and attribute encoders would be more
 * precise and, on the evidence, less likely to be applied consistently — the
 * failure here was never picking the wrong encoder, it was reaching for none.
 *
 * `&` MUST be replaced first, or the ampersands introduced by the later
 * replacements get double-encoded and a name like `Smith & Co` renders as
 * `Smith &amp;amp; Co`.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

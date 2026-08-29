// Pure presentation, deliberately NOT in quotePrintDocument.ts. That module is
// "server-only" because it reaches the database, and importing it from a test
// fails to resolve. This function renders a string and touches nothing, so it
// lives where its behaviour can actually be asserted rather than pattern-matched
// out of its own source.

/**
 * The toolbar above a printable document.
 *
 * THE BUTTON MUST NOT USE onclick, AND THAT IS NOT STYLE. The app's CSP sets
 * script-src to 'self' plus a per-request nonce, with no 'unsafe-inline' and no
 * 'unsafe-hashes' (see lib/csp.ts). An inline handler is therefore refused by
 * the browser and the button silently does nothing - no error the person can
 * see, just a dead control on the one screen they came here to use.
 *
 * The nonce is taken from the x-nonce request header, which the proxy sets on
 * every allowed request for exactly this purpose. Without one, the button is
 * rendered as a plain link to the browser's own print dialog is not possible,
 * so it is omitted entirely rather than shipped dead: a missing button is
 * honest, a present one that does nothing is not.
 */
export function printToolbarHtml(backHref: string, backLabel: string, nonce?: string | null): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  return `<div class="doc-toolbar" style="position:sticky;top:0;z-index:50;display:flex;gap:8px;align-items:center;justify-content:flex-end;padding:10px 14px;background:#0f172a;font-family:Helvetica,Arial,sans-serif">
    <a href="${esc(backHref)}" style="color:#cbd5e1;text-decoration:none;font-size:13px;margin-right:auto">&larr; ${esc(backLabel)}</a>
    ${nonce ? `<button type="button" id="doc-print" style="background:#ea580c;color:#fff;border:none;border-radius:6px;padding:8px 16px;font-size:13px;font-weight:700;cursor:pointer">Print / Save PDF</button>` : ""}
  </div>${nonce ? `<script nonce="${esc(nonce)}">document.getElementById("doc-print").addEventListener("click", function () { window.print(); });</script>` : ""}`;
}

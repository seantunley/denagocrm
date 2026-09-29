/**
 * Email-safe building blocks — the composer half of the Dittofeed borrow.
 *
 * `docs/dittofeed-borrow-queue.md` queued their `emailo` editor because our rich
 * editor, being a web editor, can only produce web markup — and the single most
 * wanted element in a marketing email, a button, CANNOT be written as web
 * markup and survive. A `<button>`, or an `<a>` styled with padding alone, is
 * exactly what Outlook's Word renderer mangles. The mature answer is two decades
 * old: a nested presentation table with every style inline, the so-called
 * bulletproof button. Nobody should hand-write it, so the editor inserts it.
 *
 * This module is the PURE half: string in, string out, no DOM, no Tiptap, no
 * server imports — usable from the editor (client), the tests (node) and any
 * server render alike. The Tiptap nodes in `emailBlockNodes.ts` call these for
 * their `renderHTML`, so the markup the author sees in the editor is
 * byte-for-byte the markup that is sent.
 *
 * ── RULES EVERY BLOCK FOLLOWS ───────────────────────────────────────────────
 *
 * 1. INLINE STYLES ONLY, never a class. There is no stylesheet in a mail
 *    client's rendering of our mail, so a class is a style that silently does
 *    not exist. This also makes the blocks safe under `inlineEmailStyles`,
 *    which by design leaves tables alone and never overrides an inline style.
 * 2. `role="presentation"` tables, because a layout table read as data by a
 *    screen reader announces rows and columns of nothing.
 * 3. A `data-email-*` marker plus data-attributes carrying the block's real
 *    parameters. That is what lets the Tiptap node PARSE its own output back —
 *    an author reopening a saved template gets an editable button, not a frozen
 *    blob of table soup.
 * 4. Everything interpolated is escaped here, at the last point it is still a
 *    string. Labels and URLs are author-controlled, but authors paste.
 */

export const EMAIL_BUTTON_COLORS = [
  "#ea580c", // the app's orange — default
  "#0f172a",
  "#2563eb",
  "#059669",
  "#dc2626",
] as const;

export type EmailButtonAlign = "left" | "center";

export type EmailButtonAttrs = {
  label: string;
  url: string;
  color?: string;
  align?: EmailButtonAlign;
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Only a real colour reaches a style attribute; anything odd gets the default. */
function safeColor(color?: string): string {
  return color && /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : EMAIL_BUTTON_COLORS[0];
}

/**
 * A URL that is allowed into an href: absolute http(s), or one that BEGINS with
 * a template variable (`{{portal_link}}`), which `renderTemplate` resolves at
 * send. Everything else — `javascript:`, protocol-relative, a stray word —
 * renders as `#` rather than shipping something executable to a mail client.
 */
function safeUrl(url: string): string {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed) || /^\{\{\s*\w+\s*\}\}/.test(trimmed)) return trimmed;
  return "#";
}

function clampSpacerHeight(height: number): number {
  const rounded = Math.round(Number(height) || 0);
  return Math.max(8, Math.min(96, rounded || 24));
}

/**
 * The bulletproof CTA button.
 *
 * Structure over cleverness: an outer table for alignment, one cell carrying
 * the background and radius, and a fat-padded `<a>` inside it. The padding
 * lives on the ANCHOR so the whole visible button is clickable, and the cell
 * repeats the background so Outlook — which ignores the anchor's display and
 * radius — still paints a solid rectangle a reader recognises as the button.
 *
 * The href is a plain `href="https://…"`, which is exactly the shape
 * `trackedLinkPattern` rewrites at send — a button in a campaign gets click
 * tracking with no extra work, because it is just a link wearing a table.
 */
export function emailButtonHtml(attrs: EmailButtonAttrs): string {
  const color = safeColor(attrs.color);
  const align: EmailButtonAlign = attrs.align === "left" ? "left" : "center";
  const label = escapeHtml(attrs.label.trim() || "Open");
  const url = escapeHtml(safeUrl(attrs.url));
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${align}"` +
    ` data-email-block="button" data-label="${label}" data-url="${url}" data-color="${color}" data-align="${align}"` +
    ` style="margin:16px ${align === "center" ? "auto" : "0"};">` +
    `<tr><td style="border-radius:8px;background:${color};">` +
    `<a href="${url}" target="_blank" style="display:inline-block;padding:12px 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px;">${label}</a>` +
    `</td></tr></table>`
  );
}

/** A divider that is a border, not an `<hr>` — clients restyle `<hr>` freely. */
export function emailDividerHtml(): string {
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" data-email-block="divider" style="margin:20px 0;">` +
    `<tr><td style="border-top:1px solid #e2e8f0;font-size:0;line-height:0;">&nbsp;</td></tr></table>`
  );
}

/**
 * Vertical space that survives every client. Margins on block elements are the
 * normal way and the unreliable way — Outlook collapses some and doubles
 * others — so space an author asks for explicitly is a sized table cell.
 */
export function emailSpacerHtml(height = 24): string {
  const px = clampSpacerHeight(height);
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" data-email-block="spacer" data-height="${px}">` +
    `<tr><td style="height:${px}px;line-height:${px}px;font-size:0;">&nbsp;</td></tr></table>`
  );
}

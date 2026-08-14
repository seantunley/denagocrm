/**
 * Inline styles for editor-authored email body content.
 *
 * ── WHAT THIS IS, AND WHAT IT IS NOT ────────────────────────────────────────
 *
 * This is the send-time half of the Dittofeed borrow, and it is deliberately NOT
 * MJML. `docs/dittofeed-borrow-queue.md` queued MJML on the reasoning that
 * responsive email HTML is a nasty problem and MJML is the mature answer. Both
 * true, and neither is the problem we actually have:
 *
 *   - The FRAME is already solved. `emailShell` in campaigns.ts is a 600px
 *     `role="presentation"` table with inline styles, a viewport meta and an
 *     absolute logo URL. Rewriting that as MJML would replace verified,
 *     brand-aware, tracking-aware markup to gain nothing.
 *   - The BODY is the gap, and MJML cannot help with it unless the body is
 *     authored AS MJML — which would mean storing the document as TipTap JSON,
 *     plumbing that JSON from template to campaign to send, and leaving every
 *     template written before the change unimproved.
 *
 * What the body actually lacks is inline styles. A `<p>` or a `<ul>` with no
 * `style` attribute is at the mercy of each client's default stylesheet, and
 * Outlook's are notoriously not the browser's. So this walks the body and puts
 * the styles in the one place every mail client honours: the tag itself.
 *
 * The upside over the MJML route is coverage. It applies to EVERY campaign body
 * regardless of where the HTML came from — the new editor, the old monospace
 * textarea, an import — rather than only to newly-authored documents.
 *
 * ── WHY TABLES ARE LEFT ALONE ───────────────────────────────────────────────
 *
 * Deliberate, and the most important decision here. Campaign bodies include HTML
 * hand-written in the old textarea, and in email a `<table>` is as likely to be
 * LAYOUT as it is to be data. Giving every `<td>` a border would put visible
 * lines through somebody's existing newsletter the first time it was resent.
 *
 * Under-styling is recoverable — the mail is plain but correct. Over-styling
 * changes mail that already worked, silently, at send time. So typography and
 * images are styled and tables are not, and a table from the editor goes out
 * without borders. That is the trade, made on purpose.
 *
 * ── AN AUTHOR'S OWN STYLE ALWAYS WINS ───────────────────────────────────────
 *
 * Defaults are prepended to any existing `style` attribute rather than replacing
 * it. Later declarations win in CSS, so `<p style="margin:0">` keeps its zero
 * margin and picks up only the properties it did not set.
 */

/**
 * The default declarations per tag, as they will appear in the attribute.
 *
 * Conservative on purpose: spacing, line height and the handful of properties
 * clients disagree about. No colours except the link, no font families — the
 * shell sets the family once on `<body>` and inheriting it is both correct and
 * what an author changing it would expect.
 */
const TAG_STYLES: Record<string, string> = {
  // `margin: 0 0 16px` rather than a top margin: adjacent paragraphs otherwise
  // collapse differently across clients, and Outlook does not collapse at all.
  p: "margin:0 0 16px 0;line-height:1.6;",
  h1: "margin:0 0 16px 0;font-size:24px;line-height:1.3;font-weight:bold;",
  h2: "margin:0 0 12px 0;font-size:20px;line-height:1.3;font-weight:bold;",
  h3: "margin:0 0 12px 0;font-size:17px;line-height:1.35;font-weight:bold;",
  // Padding, not margin: Outlook indents lists with padding and ignores the
  // margin, so setting only the margin produces a list that is flush left there
  // and indented everywhere else.
  ul: "margin:0 0 16px 0;padding-left:24px;",
  ol: "margin:0 0 16px 0;padding-left:24px;",
  li: "margin:0 0 6px 0;line-height:1.6;",
  // The one colour. A link that inherits the surrounding text colour is a link
  // nobody can see, which is worse than a colour an author may not have chosen.
  a: "color:#2563eb;text-decoration:underline;",
  blockquote: "margin:0 0 16px 0;padding:0 0 0 16px;border-left:3px solid #e2e8f0;color:#475569;",
  hr: "border:0;border-top:1px solid #e2e8f0;margin:24px 0;",
  // `display:block` kills the descender gap under an image in most clients;
  // `max-width` is what keeps a wide image from bursting the 600px shell on a
  // phone, and `height:auto` stops it being squashed when it does.
  img: "display:block;max-width:100%;height:auto;",
};

/**
 * Tags whose opening tag we will rewrite. Derived from the table above so the
 * two can never disagree about which tags are handled.
 */
const STYLED_TAGS = new Set(Object.keys(TAG_STYLES));

/**
 * Matches an opening tag and captures its name and its attributes.
 *
 * `[^>]*` for the attributes is sufficient here and would not be for a general
 * parser: an attribute value containing `>` would end the match early. That is a
 * real limitation and the reason this only ever ADDS a style attribute rather
 * than restructuring anything — the worst outcome of a mis-parse is a tag left
 * unstyled, not markup broken.
 *
 * Closing tags are excluded by requiring a letter immediately after `<`.
 */
const OPEN_TAG = /<([a-zA-Z][a-zA-Z0-9]*)((?:\s[^>]*)?)(\/?)>/g;

/** Pull an existing `style="…"` out of an attribute string, if there is one. */
const STYLE_ATTR = /\sstyle\s*=\s*("([^"]*)"|'([^']*)')/i;

/**
 * Add email-safe inline styles to a body fragment.
 *
 * Idempotent in effect rather than in text: running it twice prepends the
 * defaults again, and because later declarations win the result renders the
 * same. It is called once, at send.
 */
export function inlineEmailStyles(html: string): string {
  if (!html) return html;
  return html.replace(OPEN_TAG, (whole, rawName: string, attrs: string, selfClose: string) => {
    const name = rawName.toLowerCase();
    const defaults = TAG_STYLES[name];
    if (!defaults || !STYLED_TAGS.has(name)) return whole;

    const existing = attrs.match(STYLE_ATTR);
    if (!existing) {
      return `<${rawName}${attrs} style="${defaults}"${selfClose}>`;
    }
    // Prepended, so the author's own declarations come last and win.
    const value = existing[2] ?? existing[3] ?? "";
    const merged = `${defaults}${value.trim()}`;
    const rest = attrs.replace(STYLE_ATTR, "");
    return `<${rawName}${rest} style="${merged}"${selfClose}>`;
  });
}

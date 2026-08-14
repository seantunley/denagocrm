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

/** Pull an existing `style="…"` out of an attribute string, if there is one. */
const STYLE_ATTR = /\sstyle\s*=\s*("([^"]*)"|'([^']*)')/i;

/**
 * WHY THIS IS A SCANNER AND NOT A REGEX.
 *
 * The first version matched opening tags with `<([a-zA-Z][a-zA-Z0-9]*)((?:\s[^>]*)?)(\/?)>`
 * and claimed that the worst outcome of a mis-parse was a tag left unstyled. That
 * claim was FALSE, and the counter-example is ordinary markup:
 *
 *     <a title="1 > 0">go</a>
 *
 * `[^>]*` stops at the `>` INSIDE the quoted title, so the match is `<a title="1 >`
 * — and the replacement then writes a `style` attribute into the middle of that
 * quoted value, leaving ` 0">go</a>` behind as text. It does not under-style; it
 * corrupts the document, at send, in mail that is already on its way out.
 *
 * A quote-aware scan is the fix, and it is barely more code: walk the string, and
 * once inside a tag, track whether we are inside `"` or `'` so that a `>` there is
 * a character rather than the end of the tag.
 *
 * This still is not a full HTML parser and does not need to be. It never
 * restructures — it reads one opening tag at a time and rewrites that tag alone —
 * so the properties that matter are that it finds the true end of a tag and that
 * anything it does not understand is copied through untouched.
 */

/** Where an opening tag ends, honouring quoted attribute values. -1 if unterminated. */
function tagEnd(html: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") return i;
  }
  // Unterminated — a truncated body, or a stray `<`. The caller copies the rest
  // through verbatim rather than guessing where the tag was meant to stop.
  return -1;
}

/** The tag name at `start`, or null when this `<` does not begin one. */
function tagNameAt(html: string, start: number): string | null {
  const match = /^<([a-zA-Z][a-zA-Z0-9]*)/.exec(html.slice(start, start + 16));
  return match ? match[1] : null;
}

/**
 * Add email-safe inline styles to a body fragment.
 *
 * Idempotent in effect rather than in text: running it twice prepends the
 * defaults again, and because later declarations win the result renders the
 * same. It is called once, at send.
 */
export function inlineEmailStyles(html: string): string {
  if (!html) return html;

  let out = "";
  let cursor = 0;
  while (cursor < html.length) {
    const open = html.indexOf("<", cursor);
    if (open === -1) {
      out += html.slice(cursor);
      break;
    }
    out += html.slice(cursor, open);

    // Closing tags, comments, doctypes and a bare `<` in text all land here and
    // are copied through as-is.
    const rawName = tagNameAt(html, open);
    if (!rawName) {
      out += "<";
      cursor = open + 1;
      continue;
    }

    const end = tagEnd(html, open + 1 + rawName.length);
    if (end === -1) {
      out += html.slice(open);
      break;
    }

    const name = rawName.toLowerCase();
    const defaults = TAG_STYLES[name];
    if (!defaults || !STYLED_TAGS.has(name)) {
      out += html.slice(open, end + 1);
      cursor = end + 1;
      continue;
    }

    // Everything between the name and the `>`, minus a trailing `/` on a
    // self-closing tag, which has to survive in the same position.
    let attrs = html.slice(open + 1 + rawName.length, end);
    let selfClose = "";
    if (attrs.endsWith("/")) {
      attrs = attrs.slice(0, -1);
      selfClose = "/";
    }

    const existing = attrs.match(STYLE_ATTR);
    if (!existing) {
      out += `<${rawName}${attrs} style="${defaults}"${selfClose}>`;
    } else {
      // Prepended, so the author's own declarations come last and win.
      const value = existing[2] ?? existing[3] ?? "";
      out += `<${rawName}${attrs.replace(STYLE_ATTR, "")} style="${defaults}${value.trim()}"${selfClose}>`;
    }
    cursor = end + 1;
  }
  return out;
}

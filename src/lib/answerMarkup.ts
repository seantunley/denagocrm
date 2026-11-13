/**
 * DAX's answers, read for formatting (Sean, 2026-11-13: "rendering short lists, bold and small tables would make
 * 'my five stuck deals' readable at a glance").
 *
 * A SMALL, CLOSED set — exactly what DAX is told it may write: **bold**, "-" / "1." lists, small "| a | b |" tables,
 * [label](href) links and the server's [[n]] citation markers. Everything else stays text. No HTML is ever produced
 * from the answer: the renderer (AnswerMarkup.tsx) builds React elements from these pieces, so text a customer
 * typed into a note that DAX quotes can't inject anything. Pure, so it is tested without a browser.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "bold"; v: string }
  | { t: "link"; label: string; href: string; external: boolean }
  | { t: "cite"; n: number };

export type Block =
  | { type: "p"; lines: Inline[][] }
  | { type: "ul" | "ol"; items: Inline[][] }
  | { type: "table"; head: Inline[][]; rows: Inline[][][] };

const INLINE = /\*\*([^*\n]+?)\*\*|\[\[(\d+)\]\]|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/** Where a link may go: a path inside the app, or a web address. Anything else (javascript:, data:, //host) is text. */
function safeHref(href: string): { href: string; external: boolean } | null {
  if (href.startsWith("/") && !href.startsWith("//")) return { href, external: false };
  if (/^https?:\/\/[^\s]+$/i.test(href)) return { href, external: true };
  return null;
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > at) out.push({ t: "text", v: text.slice(at, m.index) });
    if (m[1] !== undefined) out.push({ t: "bold", v: m[1] });
    else if (m[2] !== undefined) out.push({ t: "cite", n: Number(m[2]) });
    else {
      const target = safeHref(m[4]);
      out.push(target ? { t: "link", label: m[3], ...target } : { t: "text", v: m[3] });
    }
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ t: "text", v: text.slice(at) });
  return out;
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d{1,2}[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;

const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());

/** The answer → blocks. Lines that aren't a list or a table stay a paragraph, line breaks kept (as before). */
export function parseAnswer(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: Inline[][] = [];
  const flush = () => {
    if (para.length) blocks.push({ type: "p", lines: para });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { flush(); continue; }
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      flush();
      const head = cells(line).map(parseInline);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i])) rows.push(cells(lines[i++]).map(parseInline));
      i -= 1;
      blocks.push({ type: "table", head, rows });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      flush();
      const type = bullet ? "ul" : "ol";
      const last = blocks[blocks.length - 1];
      const item = parseInline((bullet ?? numbered)![1]);
      if (last && last.type === type) last.items.push(item);
      else blocks.push({ type, items: [item] });
      continue;
    }
    const heading = HEADING.exec(line);
    // A heading DAX wasn't asked for reads as a bold line, not a big title in a chat bubble.
    para.push(heading ? [{ t: "bold", v: heading[1] }] : parseInline(line));
  }
  flush();
  return blocks;
}

/**
 * The same answer for WhatsApp, which has its own few marks: *bold*, and no tables or links. A table becomes one line
 * per row ("a · b · c", the header row in bold); **bold** becomes *bold*; a heading's hashes go.
 */
export function answerForWhatsApp(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      out.push(`*${cells(line).join(" · ")}*`);
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i])) out.push(cells(lines[i++]).join(" · "));
      i -= 1;
      continue;
    }
    const heading = HEADING.exec(line);
    out.push(heading ? `*${heading[1]}*` : line);
  }
  return out.join("\n").replace(/\*\*([^*\n]+?)\*\*/g, "*$1*");
}

/**
 * The document's own type and colour — one place, read by the printed page, the
 * signing sheet AND the editor page.
 *
 * The editor page had no type rules at all: a heading drew at body size on the
 * canvas and at 20pt in the PDF, a paragraph had no space under it on the
 * canvas and 8px in print. Whatever these functions say is what all three draw.
 *
 * Every setting is optional and its absence means "exactly as before": a stored
 * document with none of them produces the same CSS it always did.
 */
import { cssColor } from "./css";
import { DOCUMENT_FONT_FAMILY } from "./documentFont";
import type { DocStyle, DocumentBlock, DocumentModel } from "./model";

type Font = DocStyle["fontFamily"];

export function fontStack(f: Font): string {
  // Sans leads with the embedded Geist (DOCUMENT_FONT_FACE): the PDF renderer has
  // no Helvetica/Arial, and its fallback printed uneven, jagged letters.
  return f === "serif" ? "Georgia, 'Times New Roman', serif" : f === "mono" ? "'Courier New', monospace" : `'${DOCUMENT_FONT_FAMILY}', Helvetica, Arial, sans-serif`;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const pt = (n: number) => `${Math.round(n * 100) / 100}pt`;

/** The resolved type values. With nothing set: 11pt / 1.5 / #1e293b, headings 20/15/12pt in the ink colour. */
export function docType(style: DocStyle, sans: string = fontStack("sans")) {
  const body = clamp(Number(style.bodySize) || 11, 8, 14);
  const k = body / 11; // headings keep their proportion to the body text
  const face = (f: Font) => (f === "sans" ? sans : fontStack(f));
  return {
    font: face(style.fontFamily),
    body: pt(body),
    lineHeight: String(clamp(Number(style.lineHeight) || 1.5, 1.1, 2)),
    text: cssColor(style.textColor, "#1e293b"),
    ink: cssColor(style.ink, "#020617"),
    accent: cssColor(style.accent, "#ea580c"),
    h1: pt(20 * k), h2: pt(15 * k), h3: pt(12 * k),
    /** Only when the headings are set in a different face from the body. */
    headingFont: style.headingFont && style.headingFont !== style.fontFamily ? `font-family:${face(style.headingFont)};` : "",
  };
}

/**
 * The type rules for running text, under `scope` — the editor page's wrapper.
 * (The printed page and the signing sheet keep their own rule text, filled from
 * docType, so their output does not change by a byte for a stored document.)
 *
 * `sans` is the editor's name for the sans face: the app loads the same Geist
 * the renderer embeds, under its own font variable.
 */
export function docTypeCss(style: DocStyle, scope: string, sans?: string): string {
  const t = docType(style, sans);
  return `
    ${scope} { font-family:${t.font}; font-size:${t.body}; line-height:${t.lineHeight}; color:${t.text}; }
    ${scope} h1, ${scope} .slate-h1 { font-size:${t.h1}; font-weight:700; margin:0 0 8px; color:${t.ink}; ${t.headingFont} }
    ${scope} h2, ${scope} .slate-h2 { font-size:${t.h2}; font-weight:700; margin:12px 0 6px; color:${t.ink}; ${t.headingFont} }
    ${scope} h3, ${scope} .slate-h3 { font-size:${t.h3}; font-weight:700; margin:10px 0 4px; color:${t.ink}; ${t.headingFont} }
    ${scope} p, ${scope} .slate-p { margin:0 0 8px; }
    ${scope} a { color:${t.accent}; }
    ${scope} strong { font-weight:700; }
    ${scope} blockquote, ${scope} .slate-blockquote { border-left:3px solid ${t.accent}; margin:8px 0; padding:4px 12px; color:#475569; background:#f8fafc; }
    ${scope} ul, ${scope} ol { margin:0 0 8px 20px; }
    ${scope} ul { list-style:disc; } ${scope} ol { list-style:decimal; }`;
}

/**
 * Ready-made type settings. They set the face, size, spacing and margin — never
 * a colour: the colours are the workspace's brand and a preset must not undo it.
 */
export const STYLE_PRESETS = [
  { key: "modern", name: "Modern", hint: "Clean sans-serif, comfortable spacing", style: { fontFamily: "sans", headingFont: undefined, bodySize: 11, lineHeight: 1.5 } },
  { key: "classic", name: "Classic", hint: "Serif throughout — formal agreements and letters", style: { fontFamily: "serif", headingFont: undefined, bodySize: 11, lineHeight: 1.55 } },
  { key: "editorial", name: "Editorial", hint: "Serif headings over sans-serif text", style: { fontFamily: "sans", headingFont: "serif", bodySize: 10.5, lineHeight: 1.6 } },
  { key: "compact", name: "Compact", hint: "Smaller, tighter text — fits more on a page", style: { fontFamily: "sans", headingFont: undefined, bodySize: 9.5, lineHeight: 1.35 } },
] as const satisfies readonly { key: string; name: string; hint: string; style: Partial<DocStyle> }[];

/** The preset a document's type settings match exactly, if any. */
export function activePreset(style: DocStyle): string | null {
  const t = { fontFamily: style.fontFamily, headingFont: style.headingFont && style.headingFont !== style.fontFamily ? style.headingFont : undefined, bodySize: style.bodySize ?? 11, lineHeight: style.lineHeight ?? 1.5 };
  return STYLE_PRESETS.find((p) => p.style.fontFamily === t.fontFamily && p.style.headingFont === t.headingFont && p.style.bodySize === t.bodySize && p.style.lineHeight === t.lineHeight)?.key ?? null;
}

/**
 * Change one of the document's two brand colours — and every block drawn in it.
 *
 * Each block carries its own colours (a banner's fill, a card's accent), so the
 * document's "Accent" control changed links and nothing else. This swaps the
 * colour wherever a block uses EXACTLY the old one. A block someone deliberately
 * coloured differently does not match, and is left alone.
 */
export function recolour(doc: DocumentModel, which: "accent" | "ink", to: string): DocumentModel {
  const from = doc.style[which].toLowerCase();
  if (cssColor(to, "") === "" || from === to.toLowerCase()) return doc;
  const swap = (value: string) => (value.toLowerCase() === from ? to : value);
  // Only a block's own top-level colour settings and its box — never its text, its cells or anything nested.
  const paint = (block: DocumentBlock): DocumentBlock => {
    const next = { ...block } as Record<string, unknown>;
    for (const key of BLOCK_COLOUR_KEYS) { const value = next[key]; if (typeof value === "string") next[key] = swap(value); }
    const settings = block.settings ?? {};
    next.settings = { ...settings, ...(settings.background ? { background: swap(settings.background) } : {}), ...(settings.borderColor ? { borderColor: swap(settings.borderColor) } : {}) };
    if (block.type === "conditional") next.blocks = block.blocks.map(paint);
    return next as DocumentBlock;
  };
  const floats = <F extends { block: DocumentBlock }>(list: F[]) => list.map((fb) => ({ ...fb, block: paint(fb.block) }));
  return {
    ...doc,
    style: { ...doc.style, [which]: to },
    header: doc.header.map(paint),
    footer: doc.footer.map(paint),
    pages: doc.pages.map((page) => ({
      ...page,
      rows: page.rows.map((row) => ({ ...row, columns: row.columns.map((col) => ({ ...col, blocks: col.blocks.map(paint) })) })),
      floatingBlocks: floats(page.floatingBlocks),
      ...(page.overflowGroups ? { overflowGroups: page.overflowGroups.map((g) => (g.nextPageFloats ? { ...g, nextPageFloats: floats(g.nextPageFloats) } : g)) } : {}),
    })),
  };
}

/** The settings on a block that hold a colour (see the colorField()s in ./model.ts). */
const BLOCK_COLOUR_KEYS = ["accent", "color", "bg", "headerBg", "headerColor", "background"] as const;

/**
 * BlockNote JSON (the Studio free-form editor) → the document editor's model.
 *
 * Studio templates and clauses are stored as BlockNote block arrays. Folding
 * them into the one editor means reading that shape and writing ours: text runs
 * become Plate rich-text blocks (the `text`/`heading` block value), tables
 * become `table` blocks, images `image` blocks, and `{{merge.tokens}}` typed in
 * the text become inline merge-field nodes.
 *
 * Pure (no server or React imports) so the test suite can run it, and
 * DETERMINISTIC — node ids are derived from position, never random, so the same
 * input always converts to the same document.
 *
 * Nothing is dropped silently: content the model has no field for (a link's
 * address, a file embed, a checklist tick) is kept as text.
 */
import { documentSchema, type DocumentBlock, type DocumentModel } from "./model";

type Obj = Record<string, unknown>;
type PlateNode = Obj;

const TOKEN = /\{\{\s*([\w.]+)\s*\}\}/g;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const layout = { settings: {}, locked: false, hidden: false } as const;

/** Text → Plate leaves, with every {{token}} as an inline merge-field node. */
function leaves(text: string, marks: Obj): PlateNode[] {
  const out: PlateNode[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const at = match.index ?? 0;
    if (at > last) out.push({ ...marks, text: text.slice(last, at) });
    out.push({ type: "mergeField", token: match[1], children: [{ text: "" }] });
    last = at + match[0].length;
  }
  if (last < text.length) out.push({ ...marks, text: text.slice(last) });
  return out;
}

function marksOf(styles: unknown): Obj {
  const s = obj(styles);
  const marks: Obj = {};
  if (s.bold) marks.bold = true;
  if (s.italic) marks.italic = true;
  if (s.underline) marks.underline = true;
  if (s.strike) marks.strikethrough = true;
  if (s.code) marks.code = true;
  return marks;
}

/** BlockNote inline content → Plate children (never empty — Slate needs a leaf). */
function inline(content: unknown): PlateNode[] {
  const out: PlateNode[] = [];
  for (const raw of list(content)) {
    const node = obj(raw);
    if (typeof raw === "string") out.push(...leaves(raw, {}));
    else if (node.type === "link") {
      const inner = inline(node.content);
      out.push(...inner);
      const href = str(node.href);
      // The model has no link node; keep the address so it is not lost.
      if (href && plain(node.content) !== href) out.push({ text: ` (${href})` });
    } else if (typeof node.text === "string") out.push(...leaves(node.text, marksOf(node.styles)));
    else if (node.content !== undefined) out.push(...inline(node.content));
  }
  return out.length ? out : [{ text: "" }];
}

/** Plain text of inline content, tokens kept as typed. */
function plain(content: unknown): string {
  return list(content)
    .map((raw) => {
      if (typeof raw === "string") return raw;
      const node = obj(raw);
      return typeof node.text === "string" ? node.text : plain(node.content);
    })
    .join("");
}

function align(props: Obj): Obj {
  const a = props.textAlignment;
  return a === "center" || a === "right" || a === "justify" ? { align: a } : {};
}

// ── flattening BlockNote blocks into a stream of parts ──────────────
type Part =
  | { kind: "flow"; node: PlateNode; list?: "ul" | "ol" }
  | { kind: "heading"; node: PlateNode }
  | { kind: "block"; block: DocumentBlock };

function tableBlock(id: string, content: unknown): DocumentBlock {
  const rows = list(obj(content).rows).map((row) =>
    list(obj(row).cells).map((cell) => {
      // 0.54 cells are { type: "tableCell", content }; older ones are bare inline arrays.
      const c = obj(cell);
      return plain(c.type === "tableCell" ? c.content : cell);
    }),
  );
  const width = Math.max(1, ...rows.map((r) => r.length));
  const [head, ...body] = rows.length > 1 ? rows : [[], ...rows];
  const pad = (r: string[]) => Array.from({ length: width }, (_, i) => r[i] ?? "");
  return {
    id, type: "table", ...layout, headerBg: "#020617", headerColor: "#ffffff",
    columns: pad(head).map((header) => ({ header, align: "left" as const, widthPct: Math.round(100 / width) })),
    rows: body.map((r) => ({ cells: pad(r).map((value) => ({ value })) })),
  };
}

function toParts(blocks: unknown, out: Part[], ids: { n: number }): Part[] {
  for (const raw of list(blocks)) {
    const b = obj(raw);
    const props = obj(b.props);
    const id = `bn-${ids.n++}`;
    switch (b.type) {
      case "heading": {
        const level = Math.min(3, Math.max(1, Number(props.level) || 1));
        out.push({ kind: "heading", node: { type: `h${level}`, ...align(props), children: inline(b.content) } });
        break;
      }
      case "bulletListItem":
      case "toggleListItem":
        out.push({ kind: "flow", list: "ul", node: { type: "li", children: inline(b.content) } });
        break;
      case "numberedListItem":
        out.push({ kind: "flow", list: "ol", node: { type: "li", children: inline(b.content) } });
        break;
      case "checkListItem":
        out.push({ kind: "flow", list: "ul", node: { type: "li", children: [{ text: props.checked ? "☑ " : "☐ " }, ...inline(b.content)] } });
        break;
      case "quote":
        out.push({ kind: "flow", node: { type: "blockquote", ...align(props), children: inline(b.content) } });
        break;
      case "table":
        out.push({ kind: "block", block: tableBlock(id, b.content) });
        break;
      case "image":
        out.push({ kind: "block", block: { id, type: "image", ...layout, src: str(props.url), alt: str(props.caption) || str(props.name), widthPct: 100, rounded: false } });
        break;
      case "divider":
        out.push({ kind: "block", block: { id, type: "divider", ...layout, color: "#e2e8f0", thickness: 1 } });
        break;
      case "pageBreak":
        out.push({ kind: "block", block: { id, type: "pageBreak", ...layout } });
        break;
      default: {
        // paragraph, codeBlock and anything unrecognised: keep its text; a file,
        // video or audio embed has none, so its name and address stand in.
        const url = str(props.url);
        const children = b.content !== undefined ? inline(b.content) : url ? [{ text: `${str(props.name) || "File"} (${url})` }] : null;
        if (children) out.push({ kind: "flow", node: { type: "p", ...align(props), children } });
      }
    }
    // Nested blocks (indented list items, children of a paragraph) follow their
    // parent at the same level — the model has no nesting to put them in.
    toParts(b.children, out, ids);
  }
  return out;
}

const isEmptyParagraph = (p: Part) =>
  p.kind === "flow" && !p.list && p.node.type === "p" &&
  list(p.node.children).every((c) => obj(c).text === "");

/**
 * BlockNote blocks → document blocks. Runs of paragraphs, lists and quotes
 * share one text block; a heading, table or image starts a new block.
 */
export function blockNoteToBlocks(json: unknown): DocumentBlock[] {
  const parts = toParts(json, [], { n: 0 });
  // BlockNote always ends a document with an empty paragraph; it is not content.
  while (parts.length && isEmptyParagraph(parts[parts.length - 1])) parts.pop();

  const blocks: DocumentBlock[] = [];
  let flow: PlateNode[] = [];
  let n = 0;
  const flush = () => {
    if (flow.length) blocks.push({ id: `bn-text-${n++}`, type: "text", ...layout, value: flow });
    flow = [];
  };
  for (const part of parts) {
    if (part.kind === "flow") {
      // A list item joins the list right before it, if it is the same kind.
      const last = flow[flow.length - 1];
      if (!part.list) flow.push(part.node);
      else if (last?.type === part.list) (last.children as PlateNode[]).push(part.node);
      else flow.push({ type: part.list, children: [part.node] });
    } else {
      flush();
      blocks.push(part.kind === "heading"
        ? { id: `bn-heading-${n++}`, type: "heading", ...layout, value: [part.node] }
        : part.block);
    }
  }
  flush();
  return blocks;
}

/**
 * A whole BlockNote template → a one-page document, one block per row.
 *
 * Studio printed every document inside a fixed frame — company logo and the
 * document's title above, company details below. The document editor has no
 * implicit frame, so the same two things arrive as ordinary, removable blocks:
 * a brand banner first and the brand footer last.
 */
export function blockNoteToDocument(json: unknown, title: string): DocumentModel {
  const blocks: DocumentBlock[] = [
    { id: "bn-banner", type: "banner", ...layout, title: title.toUpperCase(), docNumber: "", bg: "#020617", accent: "#ea580c", showLogo: true },
    ...blockNoteToBlocks(json),
    { id: "bn-footer", type: "footer", ...layout, variant: "brand", accent: "#ea580c", lines: [] },
  ];
  return documentSchema.parse({
    schemaVersion: 1,
    title,
    style: { fontFamily: "sans", pageSize: "A4", margin: 48, accent: "#ea580c", ink: "#020617" },
    recipients: [],
    pages: [{
      id: "bn-page",
      rows: blocks.map((block) => ({
        id: `${block.id}-row`,
        columns: [{ id: `${block.id}-col`, widthPercent: 100, blocks: [block] }],
      })),
    }],
  });
}

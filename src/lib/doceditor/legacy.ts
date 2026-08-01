/**
 * Reads the PREVIOUS builder format so old templates keep working.
 *
 * `DocBuilderTemplate.data` has held two different shapes over this app's life:
 *
 *   legacy (Puck)   { root, zones, content: [{ type: "Banner", props: {…} }, …] }
 *   current (model)  { schemaVersion: 1, pages: [{ rows: [{ columns: […] }] }] }
 *
 * `parseDocument` only accepts the second, and every caller treats a null as
 * "this document is empty". A legacy row therefore does not fail loudly — it
 * disappears:
 *
 *   • /doc-editor/[id]  falls back to `blankDocument(name)`, so the template
 *     opens BLANK. The editor autosaves, so the first stray keystroke persists
 *     that blank page over the real content.
 *   • /api/pdf/doc-editor/[id]  resolves to null → 404 "empty document".
 *   • ensureBuilderSeeded counts the row as invalid and clones a replacement
 *     next to it — which is why "Quotation" appears twice in the builder list.
 *
 * Converting on READ rather than migrating the table is deliberate:
 *   – nothing is rewritten, so a bad conversion cannot destroy the original;
 *   – it covers rows this migration never sees — DocBuilderVersion snapshots
 *     (also stored as raw Puck JSON) restored months from now, and any row in a
 *     tenant that gets provisioned later;
 *   – the row heals itself: the first real save from the editor writes back a
 *     validated DocumentModel through `saveDocEditor`.
 *
 * NOT used on `SignatureRequest.snapshotJson`. That column is the document a
 * person actually signed, and it must parse as exactly what was signed or not at
 * all — quietly re-deriving a signed artefact through a converter is precisely
 * the thing a signature is supposed to rule out. Templates convert; snapshots
 * stay strict.
 */
import type { Align, BuilderData } from "@/lib/docbuilder/blocks";
import {
  documentSchema,
  parseDocument,
  type DocumentBlock,
  type DocumentColumn,
  type DocumentModel,
  type DocumentPage,
  type DocumentRow,
} from "./model";

type LegacyBlock = { type: string; props: Record<string, unknown> };

/** Every block type the legacy editor could persist (see @/lib/docbuilder/blocks). */
const LEGACY_TYPES = new Set([
  "Banner", "Heading", "Paragraph", "Divider", "Spacer", "TwoColumn", "Table",
  "LineItems", "TotalBand", "Terms", "Signature", "Footer", "PageBreak",
  "RichText", "Columns", "Image", "Conditional",
]);

// ── prop readers ────────────────────────────────────────────────────
// Legacy rows are untrusted stored JSON: a prop can be missing, null, or the
// wrong type. Every read is defaulted so a single odd value degrades one field
// instead of failing the document.
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
const align = (v: unknown): Align => (v === "center" || v === "right" ? v : "left");
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const textItems = (v: unknown): { text: string }[] =>
  list(v).map((item) => ({ text: str((item as { text?: unknown })?.text) }));

const layout = { settings: {}, locked: false, hidden: false } as const;

/**
 * Node ids are DERIVED, never generated.
 *
 * `uid()` would make this conversion non-deterministic, and the same document
 * would come out different on every read. `sendDocForSigning` hashes the parsed
 * document into the fingerprint that decides whether an open signature request
 * can be REUSED — with random ids, a legacy template would mint a fresh request
 * (and a fresh PDF, and a fresh email) on every send. Deriving ids from the
 * legacy block id plus structural position keeps the conversion a pure function
 * of its input.
 */
const rowId = (id: string) => `${id}-row`;
const colId = (id: string, index: number) => `${id}-col${index}`;

const row = (id: string, columns: DocumentColumn[]): DocumentRow => ({
  id: rowId(id),
  columns,
  settings: { gap: 16, keepTogether: false, keepWithNext: false },
});
const column = (id: string, index: number, widthPercent: number, blocks: DocumentBlock[]): DocumentColumn => ({
  id: colId(id, index),
  widthPercent,
  blocks,
});
const page = (rows: DocumentRow[]): DocumentPage => ({
  id: "legacy-page",
  rows,
  overlayFields: [],
  floatingBlocks: [],
});

/** Plate/Slate paragraph node — the shape both `text` and `heading` blocks hold. */
function para(text: string, at: Align = "left"): Record<string, unknown>[] {
  return [{ type: "p", align: at, children: [{ text }] }];
}

function textBlock(id: string, value: Record<string, unknown>[]): DocumentBlock {
  return { id, type: "text", ...layout, value };
}

// ── block conversion ────────────────────────────────────────────────

/**
 * One legacy block → the model blocks that reproduce it, or null when the type
 * is unrecognised.
 *
 * Some legacy blocks carry content the model has no field for (a banner
 * subtitle, an image caption). Those become an adjacent text block rather than
 * being dropped — the point of this converter is that nothing is lost.
 */
function blocksFor(block: LegacyBlock, id: string): DocumentBlock[] | null {
  const p = block.props ?? {};

  switch (block.type) {
    case "Banner": {
      const banner: DocumentBlock = {
        id, type: "banner", ...layout,
        title: str(p.title, "QUOTATION"),
        docNumber: str(p.docNumber, "{{quote.number}}"),
        bg: str(p.bg, "#020617"),
        accent: str(p.accent, "#ea580c"),
        showLogo: bool(p.showLogo, true),
      };
      // subtitle / logoWidth / titleAlign / titleSize / titleFont have no model
      // equivalent. Only the subtitle carries content, so it survives as text;
      // the rest were presentation the model expresses through `style`.
      const subtitle = str(p.subtitle).trim();
      return subtitle ? [banner, textBlock(`${id}-subtitle`, para(subtitle))] : [banner];
    }

    case "Heading": {
      const level = p.level === "1" ? "h1" : p.level === "3" ? "h3" : "h2";
      return [{
        id, type: "heading", ...layout,
        value: [{ type: level, align: align(p.align), children: [{ text: str(p.text, "Heading") }] }],
      }];
    }

    case "Paragraph":
      return [textBlock(id, para(str(p.text), align(p.align)))];

    case "RichText": {
      // Already Plate JSON — the one legacy block whose value the model stores
      // verbatim. Anything that is not an array of nodes falls back to empty.
      const value = list(p.value).filter((n): n is Record<string, unknown> => !!n && typeof n === "object");
      return [textBlock(id, value.length ? value : para(""))];
    }

    case "Divider":
      return [{ id, type: "divider", ...layout, color: str(p.color, "#e2e8f0"), thickness: num(p.thickness, 1) }];

    case "Spacer":
      return [{ id, type: "spacer", ...layout, height: num(p.height, 16) }];

    case "PageBreak":
      return [{ id, type: "pageBreak", ...layout }];

    case "Table":
      return [{
        id, type: "table", ...layout,
        headerBg: str(p.headerBg, "#020617"),
        headerColor: str(p.headerColor, "#ffffff"),
        columns: list(p.columns).map((c) => {
          const col = c as Record<string, unknown>;
          return {
            header: str(col.header),
            // legacy `align` is left|center|right and the model's table column
            // agrees, so this is a straight carry-over.
            align: align(col.align),
            // legacy `width`, model `widthPct` — both percentages.
            widthPct: num(col.width, 25),
          };
        }),
        rows: list(p.rows).map((r) => ({
          cells: list((r as Record<string, unknown>).cells).map((cell) => ({
            value: str((cell as { value?: unknown })?.value),
          })),
        })),
      }];

    case "LineItems":
      // The model adds `vatRate` and configurable columns; the legacy block was
      // fixed-shape, so it takes the model's defaults.
      return [{
        id, type: "lineItems", ...layout,
        headerBg: str(p.headerBg, "#020617"),
        headerColor: str(p.headerColor, "#ffffff"),
        vatRate: 15,
        columns: [
          { key: "description", header: "Description", align: "left", showIf: "" },
          { key: "qty", header: "Qty", align: "right", showIf: "" },
          { key: "unitPrice", header: "Unit price", align: "right", showIf: "" },
          { key: "total", header: "Total", align: "right", showIf: "" },
        ],
      }];

    case "TotalBand":
      return [{
        id, type: "totalBand", ...layout,
        label: str(p.label, "TOTAL INCL. VAT"),
        amount: str(p.amount, "{{quote.total}}"),
        color: str(p.color, "#ea580c"),
      }];

    case "Terms":
      return [{ id, type: "terms", ...layout, title: str(p.title, "TERMS"), items: textItems(p.items) }];

    case "Footer":
      // "simple" — the legacy footer rendered the literal `lines` it stored. The
      // model's "brand" variant resolves the Company Profile instead, which
      // would silently REPLACE whatever the template author typed here.
      return [{
        id, type: "footer", ...layout,
        variant: "simple",
        accent: str(p.accent, "#ea580c"),
        lines: textItems(p.lines),
      }];

    case "Image": {
      const width = num(p.width, 100);
      const image: DocumentBlock = {
        id, type: "image", ...layout,
        src: str(p.src),
        alt: str(p.caption),
        // legacy `width` was px on a ~700px page; the model sizes by percent. A
        // value that is already percent-like is kept, anything larger is a px
        // measurement we cannot convert without knowing the page, so it renders
        // full width rather than guessing.
        widthPct: width > 0 && width <= 100 ? width : 100,
        rounded: bool(p.rounded, false),
      };
      const caption = str(p.caption).trim();
      return caption ? [image, textBlock(`${id}-caption`, para(caption, align(p.align)))] : [image];
    }

    case "Conditional": {
      const inner = slotBlocks(p.content, `${id}-c`);
      if (inner === null) return null;
      return [{ id, type: "conditional", ...layout, when: str(p.when), blocks: inner }];
    }

    // TwoColumn / Columns / Signature are LAYOUT: they become rows with several
    // columns, which a block list cannot express. Nested inside another slot
    // they degrade to their content in sequence — see rowsFor for the top-level
    // (and only observed) case.
    case "TwoColumn":
      return infoCards(p, id);

    case "Columns": {
      const left = slotBlocks(p.left, `${id}-l`);
      const right = slotBlocks(p.right, `${id}-r`);
      if (left === null || right === null) return null;
      return [...left, ...right];
    }

    case "Signature":
      return signatureColumns(p, id).flatMap((col) => col.blocks);

    default:
      return null;
  }
}

/** A Puck slot: an array of blocks, or absent. Null propagates an unknown type. */
function slotBlocks(slot: unknown, prefix: string): DocumentBlock[] | null {
  const out: DocumentBlock[] = [];
  const entries = list(slot);
  for (let i = 0; i < entries.length; i++) {
    const block = entries[i] as LegacyBlock;
    if (!block || typeof block.type !== "string" || !LEGACY_TYPES.has(block.type)) return null;
    const converted = blocksFor(block, str(block.props?.id) || `${prefix}${i}`);
    if (converted === null) return null;
    out.push(...converted);
  }
  return out;
}

/** TwoColumn → the two info cards it rendered, left then right. */
function infoCards(p: Record<string, unknown>, id: string): DocumentBlock[] {
  const accentLeft = bool(p.accentLeft, true);
  const ACCENT = "#ea580c", INK = "#020617";
  return [
    {
      id: `${id}-left`, type: "infoCard", ...layout,
      label: str(p.leftLabel, "PREPARED FOR"),
      name: str(p.leftName, "{{customer.name}}"),
      lines: str(p.leftLines),
      accent: accentLeft ? ACCENT : INK,
    },
    {
      id: `${id}-right`, type: "infoCard", ...layout,
      label: str(p.rightLabel),
      name: str(p.rightName),
      lines: str(p.rightLines),
      accent: accentLeft ? INK : ACCENT,
    },
  ];
}

/**
 * Signature → the sign-here areas it drew.
 *
 * The model has no signature BLOCK: real signing is `recipients` +
 * `overlayFields`, which are absolutely positioned and cannot be placed from a
 * flow block without inventing coordinates. What the legacy block actually
 * rendered was a rule with a caption under it, so that is what this reproduces —
 * a printed signature line, which is what these templates were used for.
 */
function signatureColumns(p: Record<string, unknown>, id: string): DocumentColumn[] {
  const showRight = bool(p.showRight, true);
  const line = (index: number, suffix: string, label: string): DocumentColumn =>
    column(id, index, showRight ? 50 : 100, [
      { id: `${id}-${suffix}-space`, type: "spacer", ...layout, height: 48 },
      { id: `${id}-${suffix}-rule`, type: "divider", ...layout, color: "#94a3b8", thickness: 1 },
      textBlock(`${id}-${suffix}-label`, para(label)),
    ]);
  const columns = [line(0, "left", str(p.leftLabel, "Signature & date"))];
  if (showRight) columns.push(line(1, "right", str(p.rightLabel)));
  return columns;
}

/** One legacy block → the rows it occupied, or null when the type is unrecognised. */
function rowsFor(block: LegacyBlock, id: string): DocumentRow[] | null {
  const p = block.props ?? {};

  if (block.type === "TwoColumn") {
    const [left, right] = infoCards(p, id);
    return [row(id, [column(id, 0, 50, [left]), column(id, 1, 50, [right])])];
  }
  if (block.type === "Signature") {
    return [row(id, signatureColumns(p, id))];
  }
  if (block.type === "Columns") {
    const left = slotBlocks(p.left, `${id}-l`);
    const right = slotBlocks(p.right, `${id}-r`);
    if (left === null || right === null) return null;
    // legacy ratio is a string like "50-50" / "60-40"; the leading number is the
    // left share.
    const parsed = parseInt(str(p.ratio, "50"), 10);
    const leftPct = Math.min(90, Math.max(10, Number.isFinite(parsed) ? parsed : 50));
    return [row(id, [column(id, 0, leftPct, left), column(id, 1, 100 - leftPct, right)])];
  }

  const blocks = blocksFor(block, id);
  if (blocks === null) return null;
  return [row(id, [column(id, 0, 100, blocks)])];
}

// ── entry points ────────────────────────────────────────────────────

/** True when the stored JSON is a legacy Puck tree rather than a DocumentModel. */
export function isLegacyBuilderData(input: unknown): input is BuilderData {
  if (!input || typeof input !== "object") return false;
  const data = input as Partial<BuilderData> & { schemaVersion?: unknown };
  return data.schemaVersion === undefined && Array.isArray(data.content);
}

/**
 * Convert a legacy Puck tree into a DocumentModel, or null if it cannot be
 * converted faithfully. Deterministic: the same input always yields the same
 * document, ids included.
 *
 * REFUSES on any block type it does not know, rather than skipping it. A
 * converter that silently drops what it does not understand would open the
 * template short of content, and the editor's autosave would then make that
 * loss permanent — the same failure this module exists to fix, with the
 * evidence gone. A refusal leaves the row exactly as it is today.
 */
export function legacyToDocument(input: unknown, title = "Untitled proposal"): DocumentModel | null {
  if (!isLegacyBuilderData(input)) return null;

  // Puck's `zones` held content nested in slots under an older editor build.
  // Nothing in this database uses it, and there is no faithful placement for it
  // in a page/row/column tree, so a non-empty zones map refuses rather than
  // silently dropping whatever it holds.
  if (input.zones && Object.keys(input.zones).length > 0) return null;

  const rows: DocumentRow[] = [];
  const content = list(input.content) as LegacyBlock[];
  for (let i = 0; i < content.length; i++) {
    const entry = content[i];
    if (!entry || typeof entry.type !== "string" || !LEGACY_TYPES.has(entry.type)) return null;
    const converted = rowsFor(entry, str(entry.props?.id) || `legacy${i}`);
    if (converted === null) return null;
    rows.push(...converted);
  }

  const model = {
    schemaVersion: 1 as const,
    title,
    style: { fontFamily: "sans" as const, pageSize: "A4" as const, margin: 40, accent: "#ea580c", ink: "#020617" },
    recipients: [],
    // min(1) page — an empty legacy document still has to produce a page.
    pages: [page(rows.length ? rows : [row("legacy-empty", [column("legacy-empty", 0, 100, [])])])],
    header: [],
    footer: [],
  };

  // Round-trip through the real schema rather than trusting the mapping above:
  // this is the same validation a save goes through, so anything the converter
  // gets wrong is caught here instead of reaching a render.
  const parsed = documentSchema.safeParse(model);
  return parsed.success ? parsed.data : null;
}

/**
 * Parse stored TEMPLATE JSON in either format.
 *
 * Use this wherever a `DocBuilderTemplate.data` / `DocBuilderVersion.data` blob
 * is loaded. Use `parseDocument` directly for signed snapshots.
 */
export function parseTemplateDocument(input: unknown, title?: string): DocumentModel | null {
  return parseDocument(input) ?? legacyToDocument(input, title);
}

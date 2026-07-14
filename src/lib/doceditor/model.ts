/**
 * Canonical document model for the PandaDoc-style editor.
 *
 * A document is PAGES → ROWS → COLUMNS → BLOCKS (the flow-content layer) plus a
 * per-page OVERLAY-FIELD layer (recipient/form fields anchored to the page or a
 * block). Everything is structured JSON with stable UUIDs — never generated HTML.
 *
 * Zod schemas are the source of truth (templates are untrusted content and are
 * validated on load and save); TS types are inferred from them.
 */
import { z } from "zod";

export const PAGE_SIZES = {
  A4: { w: 794, h: 1123 }, // px @ 96dpi
  Letter: { w: 816, h: 1056 },
} as const;
export type PageSizeName = keyof typeof PAGE_SIZES;

// ── shared ──────────────────────────────────────────────────────────
export const boxSpacingSchema = z.object({
  top: z.number(), right: z.number(), bottom: z.number(), left: z.number(),
}).partial();
export type BoxSpacing = z.infer<typeof boxSpacingSchema>;

export const layoutSettingsSchema = z.object({
  width: z.number().optional(),      // % of the column; <100 = narrow block
  minWidth: z.number().optional(),
  maxWidth: z.number().optional(),
  horizontalAlignment: z.enum(["left", "centre", "right", "stretch"]).optional(),
  verticalAlignment: z.enum(["top", "middle", "bottom"]).optional(),
  padding: boxSpacingSchema.optional(),
  margin: boxSpacingSchema.optional(),
  gap: z.number().optional(),
  background: z.string().optional(),
}).default({});
export type LayoutSettings = z.infer<typeof layoutSettingsSchema>;

/** Stable data binding for an inline CRM variable / bound value. */
export const bindingSchema = z.object({
  source: z.string(),   // customer | quotation | quote | jobcard | …
  path: z.string(),     // dotted path within the source scope
  fallback: z.string().default(""),
});
export type Binding = z.infer<typeof bindingSchema>;

// ── blocks (flow content) ───────────────────────────────────────────
const base = { id: z.string(), settings: layoutSettingsSchema, locked: z.boolean().default(false), hidden: z.boolean().default(false) };

/** Rich text — value is a Plate/Slate node array (validated loosely, sanitised at render). */
export const textBlockSchema = z.object({
  ...base, type: z.literal("text"),
  value: z.array(z.record(z.string(), z.unknown())).default([{ type: "p", children: [{ text: "" }] }]),
});
export const headingBlockSchema = z.object({
  ...base, type: z.literal("heading"),
  value: z.array(z.record(z.string(), z.unknown())).default([{ type: "h2", children: [{ text: "Heading" }] }]),
});
export const imageBlockSchema = z.object({
  ...base, type: z.literal("image"),
  src: z.string().default(""), alt: z.string().default(""), widthPct: z.number().default(100), rounded: z.boolean().default(false),
});
export const dividerBlockSchema = z.object({
  ...base, type: z.literal("divider"), color: z.string().default("#e2e8f0"), thickness: z.number().default(1),
});
export const spacerBlockSchema = z.object({ ...base, type: z.literal("spacer"), height: z.number().default(16) });
export const pageBreakBlockSchema = z.object({ ...base, type: z.literal("pageBreak") });

export const pricingLineSchema = z.object({
  id: z.string(),
  name: z.string().default("Item"),
  description: z.string().default(""),
  sku: z.string().default(""),
  qty: z.number().default(1),
  unitPrice: z.number().default(0),   // in major units (ZAR)
  discountPct: z.number().default(0),
  taxPct: z.number().default(15),
  optional: z.boolean().default(false),
  selected: z.boolean().default(true),
});
export type PricingLine = z.infer<typeof pricingLineSchema>;

export const pricingBlockSchema = z.object({
  ...base, type: z.literal("pricing"),
  currency: z.string().default("ZAR"),
  bound: z.boolean().default(false), // fill lines from the linked record at generate time
  lines: z.array(pricingLineSchema).default([]),
  showTax: z.boolean().default(true),
  showDiscount: z.boolean().default(true),
  accent: z.string().default("#ea580c"),
});

export const tableBlockSchema = z.object({
  ...base, type: z.literal("table"),
  columns: z.array(z.object({ header: z.string(), align: z.enum(["left", "center", "right"]).default("left"), widthPct: z.number().default(25) })).default([]),
  rows: z.array(z.object({ cells: z.array(z.object({ value: z.string() })) })).default([]),
  headerBg: z.string().default("#020617"), headerColor: z.string().default("#ffffff"),
});

// ── branded blocks (match the print templates) ──────────────────────
export const bannerBlockSchema = z.object({
  ...base, type: z.literal("banner"),
  title: z.string().default("QUOTATION"),
  docNumber: z.string().default("{{quote.number}}"),
  bg: z.string().default("#020617"),
  accent: z.string().default("#ea580c"),
  showLogo: z.boolean().default(true),
});
export const infoCardBlockSchema = z.object({
  ...base, type: z.literal("infoCard"),
  label: z.string().default("PREPARED FOR"),
  name: z.string().default("{{customer.name}}"),
  lines: z.string().default("{{customer.phone}}\n{{customer.email}}"),
  accent: z.string().default("#ea580c"),
});
export const lineItemColKeys = ["description", "qty", "unitPrice", "unitPriceExVat", "vat", "subtotal", "total"] as const;
export const lineItemColumnSchema = z.object({
  key: z.enum(lineItemColKeys),
  header: z.string(),
  align: z.enum(["left", "right"]).default("left"),
  showIf: z.string().default(""),   // safe expression against the record; empty = always show
});
export const lineItemsBlockSchema = z.object({
  ...base, type: z.literal("lineItems"),
  headerBg: z.string().default("#020617"),
  headerColor: z.string().default("#ffffff"),
  vatRate: z.number().default(15),   // used by a "vat" column (prices are VAT-inclusive)
  columns: z.array(lineItemColumnSchema).default([
    { key: "description", header: "Description", align: "left", showIf: "" },
    { key: "qty", header: "Qty", align: "right", showIf: "" },
    { key: "unitPrice", header: "Unit price", align: "right", showIf: "" },
    { key: "total", header: "Total", align: "right", showIf: "" },
  ]),
});
export type LineItemColumn = z.infer<typeof lineItemColumnSchema>;
export const totalBandBlockSchema = z.object({
  ...base, type: z.literal("totalBand"),
  label: z.string().default("TOTAL INCL. VAT"),
  amount: z.string().default("{{quote.total}}"),
  color: z.string().default("#ea580c"),
});
export const termsBlockSchema = z.object({
  ...base, type: z.literal("terms"),
  title: z.string().default("TERMS"),
  items: z.array(z.object({ text: z.string() })).default([]),
});
export const footerBlockSchema = z.object({
  ...base, type: z.literal("footer"),
  accent: z.string().default("#ea580c"),
  lines: z.array(z.object({ text: z.string() })).default([]),
});

/** Conditional wrapper — nested blocks render only when `when` is truthy (safe expr engine). */
export const conditionalBlockSchema = z.object({
  ...base, type: z.literal("conditional"),
  when: z.string().default(""),
  blocks: z.array(z.lazy(() => blockSchema)).default([]),
});

export const blockSchema: z.ZodType<DocumentBlock> = z.lazy(() => z.discriminatedUnion("type", [
  textBlockSchema, headingBlockSchema, imageBlockSchema, dividerBlockSchema, spacerBlockSchema,
  pageBreakBlockSchema, pricingBlockSchema, tableBlockSchema,
  bannerBlockSchema, infoCardBlockSchema, lineItemsBlockSchema, totalBandBlockSchema, termsBlockSchema, footerBlockSchema,
  conditionalBlockSchema,
])) as z.ZodType<DocumentBlock>;

export type TextBlock = z.infer<typeof textBlockSchema>;
export type HeadingBlock = z.infer<typeof headingBlockSchema>;
export type ImageBlock = z.infer<typeof imageBlockSchema>;
export type DividerBlock = z.infer<typeof dividerBlockSchema>;
export type SpacerBlock = z.infer<typeof spacerBlockSchema>;
export type PageBreakBlock = z.infer<typeof pageBreakBlockSchema>;
export type PricingBlock = z.infer<typeof pricingBlockSchema>;
export type TableBlock = z.infer<typeof tableBlockSchema>;
export type BannerBlock = z.infer<typeof bannerBlockSchema>;
export type InfoCardBlock = z.infer<typeof infoCardBlockSchema>;
export type LineItemsBlock = z.infer<typeof lineItemsBlockSchema>;
export type TotalBandBlock = z.infer<typeof totalBandBlockSchema>;
export type TermsBlock = z.infer<typeof termsBlockSchema>;
export type FooterBlock = z.infer<typeof footerBlockSchema>;
export type ConditionalBlock = {
  id: string; type: "conditional"; settings: LayoutSettings; locked: boolean; hidden: boolean;
  when: string; blocks: DocumentBlock[];
};
export type DocumentBlock =
  | TextBlock | HeadingBlock | ImageBlock | DividerBlock | SpacerBlock
  | PageBreakBlock | PricingBlock | TableBlock
  | BannerBlock | InfoCardBlock | LineItemsBlock | TotalBandBlock | TermsBlock | FooterBlock
  | ConditionalBlock;
export type BlockType = DocumentBlock["type"];

// ── columns / rows / pages ──────────────────────────────────────────
export const columnSchema = z.object({
  id: z.string(),
  widthPercent: z.number().default(100),
  blocks: z.array(blockSchema).default([]),
});
export type DocumentColumn = z.infer<typeof columnSchema>;

export const rowSettingsSchema = z.object({
  gap: z.number().default(16),
  padding: boxSpacingSchema.optional(),
  background: z.string().optional(),
  keepTogether: z.boolean().default(false),
  keepWithNext: z.boolean().default(false),
}).default({ gap: 16, keepTogether: false, keepWithNext: false });
export type RowSettings = z.infer<typeof rowSettingsSchema>;

export const rowSchema = z.object({
  id: z.string(),
  columns: z.array(columnSchema).min(1).default([]),
  settings: rowSettingsSchema,
});
export type DocumentRow = z.infer<typeof rowSchema>;

// ── overlay fields (recipient/form layer) ───────────────────────────
export const overlayFieldTypes = ["signature", "initials", "date", "text", "checkbox", "radio", "dropdown", "attachment", "stamp"] as const;
export const overlayAnchorSchema = z.object({
  mode: z.enum(["page", "block", "block-top", "block-bottom"]).default("page"),
  blockId: z.string().nullable().default(null),
  // offsets in px relative to the anchor origin
  x: z.number().default(48),
  y: z.number().default(48),
});
export type OverlayAnchor = z.infer<typeof overlayAnchorSchema>;

export const overlayFieldSchema = z.object({
  id: z.string(),
  kind: z.enum(overlayFieldTypes).default("signature"),
  anchor: overlayAnchorSchema,
  width: z.number().default(200),
  height: z.number().default(64),
  recipientId: z.string().nullable().default(null),
  required: z.boolean().default(true),
  label: z.string().default(""),
  options: z.array(z.string()).default([]), // for dropdown/radio
});
export type OverlayField = z.infer<typeof overlayFieldSchema>;

// ── recipients ──────────────────────────────────────────────────────
export const recipientSchema = z.object({
  id: z.string(),
  name: z.string().default(""),
  email: z.string().default(""),
  role: z.enum(["signer", "viewer", "approver"]).default("signer"),
  color: z.string().default("#2563eb"),
});
export type Recipient = z.infer<typeof recipientSchema>;

// ── free-placement content (the "both" layer) ───────────────────────
// A content block lifted out of the flow and absolutely positioned on the page.
export const floatingBlockSchema = z.object({
  id: z.string(),
  x: z.number().default(48),
  y: z.number().default(48),
  width: z.number().default(280),
  block: blockSchema,
});
export type FloatingBlock = z.infer<typeof floatingBlockSchema>;

// ── page / document ─────────────────────────────────────────────────
export const pageSchema = z.object({
  id: z.string(),
  rows: z.array(rowSchema).default([]),
  overlayFields: z.array(overlayFieldSchema).default([]),
  floatingBlocks: z.array(floatingBlockSchema).default([]),
});
export type DocumentPage = z.infer<typeof pageSchema>;

export const docStyleSchema = z.object({
  fontFamily: z.enum(["sans", "serif", "mono"]).default("sans"),
  pageSize: z.enum(["A4", "Letter"]).default("A4"),
  margin: z.number().default(48), // px
  accent: z.string().default("#ea580c"),
  ink: z.string().default("#020617"),
}).default({ fontFamily: "sans", pageSize: "A4", margin: 48, accent: "#ea580c", ink: "#020617" });
export type DocStyle = z.infer<typeof docStyleSchema>;

export const documentSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  title: z.string().default("Untitled proposal"),
  style: docStyleSchema,
  recipients: z.array(recipientSchema).default([]),
  pages: z.array(pageSchema).min(1),
  header: z.array(blockSchema).default([]),
  footer: z.array(blockSchema).default([]),
});
export type DocumentModel = z.infer<typeof documentSchema>;

/** Parse/validate untrusted stored JSON into a DocumentModel, or null if invalid. */
export function parseDocument(input: unknown): DocumentModel | null {
  const r = documentSchema.safeParse(input);
  return r.success ? r.data : null;
}

/** True when the stored JSON is a new-model document (vs a legacy Puck tree). */
export function isDocEditorModel(input: unknown): boolean {
  return !!input && typeof input === "object" && (input as { schemaVersion?: unknown }).schemaVersion === 1;
}

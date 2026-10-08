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
import { isSafeCssColor } from "./css";

/**
 * A colour a template author supplies, normalised to the default when it is not
 * one.
 *
 * These were plain `z.string()`, and the serializer splices them into
 * `style="..."` by concatenation — so `#fff" onmouseover="alert(1)" x="` closed
 * the attribute and added an event handler, on the PUBLIC signing page. See
 * ./css.ts for the full account; `fontFamily` and `align` were never affected
 * because they are `z.enum`, which is exactly the argument for constraining
 * these too.
 *
 * Normalised rather than REJECTED on purpose. Failing the parse would make a
 * template with one odd colour stop rendering altogether, and every stored
 * template already in the database has to keep working. The bad value is
 * dropped, not repaired — nothing here tries to salvage part of a payload.
 */
const colorField = (fallback: string) =>
  z.string().default(fallback).transform((value) => (isSafeCssColor(value) ? value : fallback));
/** A colour that may be left unset ("use the default"); an unsafe value is unset too. */
const optionalColor = z.string().default("").transform((value) => (isSafeCssColor(value) ? value : ""));

/**
 * Page boxes in TWO units, and both are load-bearing.
 *
 * `w`/`h` are the rounded CSS pixel sizes the editor lays out and measures with —
 * whole pixels, because a canvas that positions overlay fields on fractional
 * pixels is worse than one that is a third of a millimetre out.
 *
 * `cssH` is the EXACT physical height, and it is what the printed page box must
 * be derived from. A4 is 297mm, which is 1122.52 CSS px at 96dpi — not 1123. The
 * page div took its min-height from the rounded number, so every document was
 * half a pixel taller than the sheet it printed on and Chrome broke EVERY one of
 * them onto a second, near-empty page. Rounding down instead would leave a
 * visible sliver of unusable paper; stating the real measurement costs nothing.
 */
export const PAGE_SIZES = {
  A4: { w: 794, h: 1123, cssH: "297mm" }, // px @ 96dpi; cssH is exact
  Letter: { w: 816, h: 1056, cssH: "11in" },
  /** A customer email (./emailRender.ts): the 600px card mail apps show. Never printed. */
  Email: { w: 600, h: 760, cssH: "201.08mm" },
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
  /**
   * Type size relative to the block's own design (1 = as drawn, 0.6–2 allowed).
   *
   * Blocks set their sizes in points, so a long value — a six-figure total, a
   * long company name — had nowhere to go but onto a second line. A scale is
   * what lets the designer buy the space back without a new block.
   */
  fontScale: z.number().optional(),
  /** Alignment of the text INSIDE the block, distinct from where the block sits. */
  textAlign: z.enum(["left", "centre", "right"]).optional(),
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
  ...base, type: z.literal("divider"), color: colorField("#e2e8f0"), thickness: z.number().default(1),
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
  accent: colorField("#ea580c"),
});

export const tableBlockSchema = z.object({
  ...base, type: z.literal("table"),
  columns: z.array(z.object({ header: z.string(), align: z.enum(["left", "center", "right"]).default("left"), widthPct: z.number().default(25) })).default([]),
  rows: z.array(z.object({ cells: z.array(z.object({ value: z.string() })) })).default([]),
  headerBg: colorField("#020617"), headerColor: colorField("#ffffff"),
});

/**
 * Visual style of a shared branded block. Unset = "standard", so every stored
 * template renders byte-for-byte as before; "showcase" draws it in the showcase
 * quotation's style (lib/doceditor/showcaseRender.ts).
 */
// "classic": the invoice's quieter look (2026-10-07 mock-up) — no boxes, plain
// columns, label/value rows, a light table header.
const blockLook = z.enum(["standard", "showcase", "classic"]).optional();
/**
 * The showcase bands (header, info strip, totals, footer) can be drawn in the
 * same "classic" style. Optional: a document without it keeps its band look.
 */
const bandStyle = z.enum(["band", "classic"]).optional();

// ── branded blocks (match the print templates) ──────────────────────
export const bannerBlockSchema = z.object({
  ...base, type: z.literal("banner"),
  title: z.string().default("QUOTATION"),
  docNumber: z.string().default("{{quote.number}}"),
  bg: colorField("#020617"),
  accent: colorField("#ea580c"),
  showLogo: z.boolean().default(true),
});
export const infoCardBlockSchema = z.object({
  ...base, type: z.literal("infoCard"),
  label: z.string().default("PREPARED FOR"),
  name: z.string().default("{{customer.name}}"),
  lines: z.string().default("{{customer.phone}}\n{{customer.email}}"),
  accent: colorField("#ea580c"),
  look: blockLook,
  /** Classic look: a thin rule down the left, between two side-by-side columns. */
  divider: z.boolean().optional(),
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
  look: blockLook,
  headerBg: colorField("#020617"),
  headerColor: colorField("#ffffff"),
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
  color: colorField("#ea580c"),
});
export const termsBlockSchema = z.object({
  ...base, type: z.literal("terms"),
  title: z.string().default("TERMS"),
  items: z.array(z.object({ text: z.string() })).default([]),
  look: blockLook,
});
export const footerBlockSchema = z.object({
  ...base, type: z.literal("footer"),
  // "brand" renders the two-column company footer (name/tagline, contact, socials)
  // from the Company Profile; "simple" renders the free-text `lines` below.
  variant: z.enum(["brand", "simple"]).default("brand"),
  accent: colorField("#ea580c"),
  lines: z.array(z.object({ text: z.string() })).default([]),
});

/** Delivery handover checklist runs + customer signature, filled from the record (see ./handoverChecklist.ts). */
export const handoverChecklistBlockSchema = z.object({ ...base, type: z.literal("handoverChecklist") });

// ── showcase quotation blocks (rendered by ./showcaseRender.ts) ──────
/** Line icons the showcase blocks can draw — see SHOWCASE_ICONS in showcaseRender.ts. */
export const showcaseIconNames = [
  "calendar", "calendarCheck", "clock", "user", "seats", "range", "electric", "premium", "speed", "battery", "warranty", "charge",
] as const;
export type ShowcaseIcon = (typeof showcaseIconNames)[number];
const showcaseIcon = z.enum(showcaseIconNames).catch("premium");
export const showcaseHeaderBlockSchema = z.object({
  ...base, type: z.literal("showcaseHeader"),
  title: z.string().default("QUOTATION"),
  docNumber: z.string().default("{{quote.number}}"),
  tagline: z.string().default("PREMIUM ELECTRIC MOBILITY"),
  bg: colorField("#020617"),
  accent: colorField("#ea580c"),
  /** Optional band photo. Only an inline `data:image/…` is ever rendered. */
  bgImage: z.string().default(""),
  showLogo: z.boolean().default(true),
  /** A slimmer band (no tagline) — the header repeated on a continuation page. */
  compact: z.boolean().optional(),
  style: bandStyle,
  /** Classic: the line under the title, and the small label above the number. */
  subtitle: z.string().optional(),
  numberLabel: z.string().optional(),
});
export const infoStripBlockSchema = z.object({
  ...base, type: z.literal("infoStrip"),
  accent: colorField("#ea580c"),
  items: z.array(z.object({
    icon: showcaseIcon, label: z.string().default(""), value: z.string().default(""), sub: z.string().default(""),
  })).default([]),
  style: bandStyle,
});
/** A vehicle as the showcase shows it (lib/docbuilder/vehicleShowcase.ts VehicleShowcaseData). */
export const frozenVehicleSchema = z.object({
  name: z.string(),
  tagline: z.string().default(""),
  description: z.string().default(""),
  image: z.string().nullable().default(null),
  specs: z.array(z.object({ icon: showcaseIcon, label: z.string(), sub: z.string().default("") })).default([]),
});
/** The quote's primary vehicle — model, tagline, description, specs and photo come from its Product. */
export const vehicleShowcaseBlockSchema = z.object({
  ...base, type: z.literal("vehicleShowcase"),
  part: z.enum(["full", "details", "image"]).default("full"),
  brand: z.string().default("DENAGO EV"),
  accent: colorField("#ea580c"),
  imageHeight: z.number().default(280),
  /** "contain" shows the whole photo (cut-outs); "cover" fills the area (scenic photos). */
  imageFit: z.enum(["contain", "cover"]).default("contain"),
  /**
   * Give the page room for more line items: above `afterRows` rows (and up to
   * `untilRows`, beyond which the layout overflows to a second page instead)
   * the photo loses `perRow` px per extra row, down to `minHeight`, and the
   * details switch to a compact setting so the text column shrinks with it.
   */
  shrink: z.object({ afterRows: z.number(), untilRows: z.number(), perRow: z.number(), minHeight: z.number() }).optional(),
  /**
   * Set ONLY on a signing snapshot, at send time (lib/signing/service.ts): the
   * vehicle exactly as the signer was shown it — null meaning there was none.
   * When present it renders INSTEAD of the live Product, so editing the product
   * afterwards cannot change a document someone is signing or has signed.
   * Absent on templates, which bind to the quote live.
   */
  frozen: frozenVehicleSchema.nullable().optional(),
});
export const totalsBoxBlockSchema = z.object({
  ...base, type: z.literal("totalsBox"),
  rows: z.array(z.object({ label: z.string(), value: z.string() })).default([]),
  totalLabel: z.string().default("TOTAL INCL. VAT"),
  totalAmount: z.string().default("{{quote.total}}"),
  bg: colorField("#020617"),
  accent: colorField("#ea580c"),
  style: bandStyle,
});
export const acceptanceBlockSchema = z.object({
  ...base, type: z.literal("acceptance"),
  title: z.string().default("ACCEPTANCE OF QUOTATION"),
  text: z.string().default(""),
  nameLabel: z.string().default("Customer Name"),
  nameValue: z.string().default("{{customer.name}}"),
  signatureLabel: z.string().default("Signature"),
  dateLabel: z.string().default("Date"),
});
export const footerBandBlockSchema = z.object({
  ...base, type: z.literal("footerBand"),
  subtitle: z.string().default("{{company.tagline}}"),
  bg: colorField("#020617"),
  accent: colorField("#ea580c"),
  /** Optional band photo (e.g. a skyline). Only an inline `data:image/…` is ever rendered. */
  bgImage: z.string().default(""),
  /** Classic: one slim line (the subtitle, e.g. "name · website · Invoice no"), an accent mark beside it. */
  style: bandStyle,
});

// ── customer email blocks (rendered by ./emailRender.ts) ─────────────
// Customer emails are documents in this editor too (Sean, 2026-10-08: "We have
// all this advanced editing, and I get inline editing"). One shared FRAME
// (header, signature, footer around an emailBody slot) wraps every message's
// BODY. Print documents never contain these; the PDF serialiser draws nothing
// for them.
/**
 * The frame's header. `panel`: the workspace's logo panel (signature banner),
 * else the logo on a dark panel. `bar`: the logo on a full-width band of
 * `background`. `plain`: the logo alone on the card.
 */
export const emailHeaderBlockSchema = z.object({
  ...base, type: z.literal("emailHeader"),
  style: z.enum(["panel", "bar", "plain"]).default("panel"),
  background: colorField("#0b0f19"),
  logoWidth: z.number().default(210),
  align: z.enum(["left", "center"]).default("left"),
});
/** In the frame: where each message's own body goes. */
export const emailBodyBlockSchema = z.object({ ...base, type: z.literal("emailBody") });
/**
 * In the frame: who the email is from. The SENDER's own name, job title, mobile
 * and email when a person sends it (Sean, 2026-10-08: "It must be the senders
 * information"); the company's for an automatic message. Each line can be hidden.
 */
export const emailSignatureBlockSchema = z.object({
  ...base, type: z.literal("emailSignature"),
  showJobTitle: z.boolean().default(true),
  showCompany: z.boolean().default(true),
  showPhone: z.boolean().default(true),
  showEmail: z.boolean().default(true),
  showWebsite: z.boolean().default(true),
});
/** In the frame: company details, small and quiet, with an optional line above them. */
export const emailFooterBlockSchema = z.object({
  ...base, type: z.literal("emailFooter"),
  note: z.string().default(""),
  showCompany: z.boolean().default(true),
  showContact: z.boolean().default(true),
  align: z.enum(["left", "center", "right"]).default("center"),
  color: colorField("#94a3b8"),
  /** Empty = the card's own colour. */
  background: optionalColor,
});
/**
 * The message's action: a button that opens one of the message's links
 * (signing, review, survey), or — for a code — the code itself, shown large.
 * `token` names the message field; a message is never sent without its action.
 */
export const emailButtonBlockSchema = z.object({
  ...base, type: z.literal("emailButton"),
  token: z.string().default("signing_link"),
  label: z.string().default("Open & sign"),
  style: z.enum(["dark", "accent"]).default("dark"),
});
/** Key figures as cards, side by side (a quote's number and total). A highlighted card is dark with the accent value. */
export const emailFactsBlockSchema = z.object({
  ...base, type: z.literal("emailFacts"),
  items: z.array(z.object({
    label: z.string().default(""), value: z.string().default(""), sub: z.string().default(""), highlight: z.boolean().default(false),
  })).default([]),
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
  conditionalBlockSchema, handoverChecklistBlockSchema,
  showcaseHeaderBlockSchema, infoStripBlockSchema, vehicleShowcaseBlockSchema, totalsBoxBlockSchema, acceptanceBlockSchema, footerBandBlockSchema,
  emailHeaderBlockSchema, emailBodyBlockSchema, emailSignatureBlockSchema, emailFooterBlockSchema, emailButtonBlockSchema, emailFactsBlockSchema,
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
export type HandoverChecklistBlock = z.infer<typeof handoverChecklistBlockSchema>;
export type ShowcaseHeaderBlock = z.infer<typeof showcaseHeaderBlockSchema>;
export type InfoStripBlock = z.infer<typeof infoStripBlockSchema>;
export type VehicleShowcaseBlock = z.infer<typeof vehicleShowcaseBlockSchema>;
export type TotalsBoxBlock = z.infer<typeof totalsBoxBlockSchema>;
export type AcceptanceBlock = z.infer<typeof acceptanceBlockSchema>;
export type FooterBandBlock = z.infer<typeof footerBandBlockSchema>;
export type ShowcaseBlock =
  | ShowcaseHeaderBlock | InfoStripBlock | VehicleShowcaseBlock | TotalsBoxBlock | AcceptanceBlock | FooterBandBlock;
export type EmailHeaderBlock = z.infer<typeof emailHeaderBlockSchema>;
export type EmailBodyBlock = z.infer<typeof emailBodyBlockSchema>;
export type EmailSignatureBlock = z.infer<typeof emailSignatureBlockSchema>;
export type EmailFooterBlock = z.infer<typeof emailFooterBlockSchema>;
export type EmailButtonBlock = z.infer<typeof emailButtonBlockSchema>;
export type EmailFactsBlock = z.infer<typeof emailFactsBlockSchema>;
export type EmailBlock = EmailHeaderBlock | EmailBodyBlock | EmailSignatureBlock | EmailFooterBlock | EmailButtonBlock | EmailFactsBlock;
export const EMAIL_BLOCK_TYPES = ["emailHeader", "emailBody", "emailSignature", "emailFooter", "emailButton", "emailFacts"] as const;
export type ConditionalBlock = {
  id: string; type: "conditional"; settings: LayoutSettings; locked: boolean; hidden: boolean;
  when: string; blocks: DocumentBlock[];
};
export type DocumentBlock =
  | TextBlock | HeadingBlock | ImageBlock | DividerBlock | SpacerBlock
  | PageBreakBlock | PricingBlock | TableBlock
  | BannerBlock | InfoCardBlock | LineItemsBlock | TotalBandBlock | TermsBlock | FooterBlock
  | ConditionalBlock | HandoverChecklistBlock | ShowcaseBlock | EmailBlock;
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
  color: colorField("#2563eb"),
  /**
   * WHICH PARTY this is, decided when the template is designed.
   *
   * A template cannot know the customer's name or the sender's email — those
   * belong to the record it will be used for. Before this existed, a template
   * recipient was always a literal person, so a signature block could only be
   * assigned to someone typed in at design time; sending then threw those
   * recipients away, invented a fresh pair, and worked out which block belonged
   * to whom by pattern-matching the discarded names. Naming a party instead
   * says it outright, and it is resolved to a real person at send time.
   *
   * Defaults to "custom" so every stored document keeps its current meaning.
   */
  party: z.enum(["denago", "customer", "custom"]).default("custom"),
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
/**
 * Content pinned to the foot of a page that must MOVE to a following page when
 * the flowed content above it would run into it — the showcase quote's terms /
 * acceptance cards (with the customer's signature and date fields) and its
 * footer band. `maxItems` is how many bound line-item rows still fit above it.
 * Resolved by ./overflow.ts: at send time into the signing snapshot (so the
 * signed layout is fixed), and at render time for live documents.
 */
export const overflowGroupSchema = z.object({
  maxItems: z.number(),
  floatIds: z.array(z.string()).default([]),
  fieldIds: z.array(z.string()).default([]),
  /** When moved, lift the group so its top sits here; unset keeps its position. */
  topOnNextPage: z.number().optional(),
  /** Remove the group instead of moving it (it is already repeated on the next page). */
  drop: z.boolean().optional(),
  /** Extra content the continuation page gets when THIS group moves (a compact header, a footer). */
  nextPageFloats: z.array(floatingBlockSchema).optional(),
});
export type OverflowGroup = z.infer<typeof overflowGroupSchema>;

export const pageSchema = z.object({
  id: z.string(),
  rows: z.array(rowSchema).default([]),
  overlayFields: z.array(overlayFieldSchema).default([]),
  floatingBlocks: z.array(floatingBlockSchema).default([]),
  overflowGroups: z.array(overflowGroupSchema).optional(),
});
export type DocumentPage = z.infer<typeof pageSchema>;

export const docStyleSchema = z.object({
  fontFamily: z.enum(["sans", "serif", "mono"]).default("sans"),
  pageSize: z.enum(["A4", "Letter", "Email"]).default("A4"),
  margin: z.number().default(48), // px
  accent: colorField("#ea580c"),
  ink: colorField("#020617"),
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
  /**
   * Set ONLY on a signing snapshot, at send time: the number of line-item rows
   * the layout was resolved for (overflow pages, the showcase hero's height).
   * Renders use it instead of the live row count, so a signed layout — and the
   * signature fields placed on it — never re-flows.
   */
  layoutRows: z.number().optional(),
  /** Set on a customer EMAIL document (template key `email:<kind>`): its subject line, {{fields}} allowed. */
  /**
   * On the email FRAME (`email:frame`), the colours every email shares: the page
   * behind the card, the card, the dark button, and the accent (links, the
   * button's arrow, a highlighted figure). Empty = the standard look / the
   * workspace's brand colour.
   */
  email: z.object({
    subject: z.string().default(""),
    pageColor: optionalColor.optional(),
    cardColor: optionalColor.optional(),
    buttonColor: optionalColor.optional(),
    accentColor: optionalColor.optional(),
  }).optional(),
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

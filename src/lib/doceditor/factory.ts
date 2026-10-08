/** Factories for new document nodes — all with stable UUIDs. */
import type {
  DocumentModel, DocumentPage, DocumentRow, DocumentColumn, DocumentBlock, BlockType,
  OverlayField, Recipient, PricingLine,
} from "./model";
import { DEFAULT_REGIONAL } from "@/lib/format";

export function uid(): string {
  // crypto.randomUUID is available in modern browsers and Node 18+.
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Math.abs(Date.now() ^ (Math.floor((performance?.now?.() ?? 0) * 1000))).toString(36);
}

export function newColumn(widthPercent = 100, blocks: DocumentBlock[] = []): DocumentColumn {
  return { id: uid(), widthPercent, blocks };
}
export function newRow(columns?: DocumentColumn[]): DocumentRow {
  return { id: uid(), columns: columns ?? [newColumn(100)], settings: { gap: 16, keepTogether: false, keepWithNext: false } };
}
export function newPage(rows: DocumentRow[] = []): DocumentPage {
  return { id: uid(), rows, overlayFields: [], floatingBlocks: [] };
}

const emptyLayout = { locked: false, hidden: false, settings: {} } as const;

export function newPricingLine(over: Partial<PricingLine> = {}): PricingLine {
  return { id: uid(), name: "Item", description: "", sku: "", qty: 1, unitPrice: 0, discountPct: 0, taxPct: 15, optional: false, selected: true, ...over };
}

export function newBlock(type: BlockType): DocumentBlock {
  switch (type) {
    case "text":
      return { id: uid(), type, ...emptyLayout, value: [{ type: "p", children: [{ text: "Type your text here…" }] }] };
    case "heading":
      return { id: uid(), type, ...emptyLayout, value: [{ type: "h2", children: [{ text: "Section heading" }] }] };
    case "image":
      return { id: uid(), type, ...emptyLayout, src: "", alt: "", widthPct: 100, rounded: false };
    case "divider":
      return { id: uid(), type, ...emptyLayout, color: "#e2e8f0", thickness: 1 };
    case "spacer":
      return { id: uid(), type, ...emptyLayout, height: 16 };
    case "pageBreak":
      return { id: uid(), type, ...emptyLayout };
    case "pricing":
      return {
        id: uid(), type, ...emptyLayout, currency: DEFAULT_REGIONAL.currency, bound: false, showTax: true, showDiscount: true, accent: "#ea580c",
        lines: [newPricingLine({ name: "Denago Rover XL", unitPrice: 189900, qty: 1 }), newPricingLine({ name: "On-road & handover", unitPrice: 4500, qty: 1 })],
      };
    case "table":
      return {
        id: uid(), type, ...emptyLayout, headerBg: "#020617", headerColor: "#ffffff",
        columns: [{ header: "Description", align: "left", widthPct: 60 }, { header: "Qty", align: "right", widthPct: 20 }, { header: "Amount", align: "right", widthPct: 20 }],
        rows: [{ cells: [{ value: "Item" }, { value: "1" }, { value: "0.00" }] }],
      };
    case "banner":
      return { id: uid(), type, ...emptyLayout, title: "QUOTATION", docNumber: "{{quote.number}}", bg: "#020617", accent: "#ea580c", showLogo: true };
    case "infoCard":
      return { id: uid(), type, ...emptyLayout, label: "PREPARED FOR", name: "{{customer.name}}", lines: "{{customer.phone}}\n{{customer.email}}", accent: "#ea580c" };
    case "lineItems":
      return {
        id: uid(), type, ...emptyLayout, headerBg: "#020617", headerColor: "#ffffff", vatRate: 15,
        columns: [
          { key: "description", header: "Description", align: "left", showIf: "" },
          { key: "qty", header: "Qty", align: "right", showIf: "" },
          { key: "unitPrice", header: "Unit price", align: "right", showIf: "" },
          { key: "total", header: "Total", align: "right", showIf: "" },
        ],
      };
    case "totalBand":
      return { id: uid(), type, ...emptyLayout, label: "TOTAL INCL. VAT", amount: "{{quote.total}}", color: "#ea580c" };
    case "terms":
      return { id: uid(), type, ...emptyLayout, title: "TERMS", items: [{ text: "Prices include VAT." }] };
    case "footer":
      // Brand footer — resolves name, contact details and socials from the
      // editable Company Profile at render time, so it stays correct when the
      // company details change. `lines` is the fallback for the "simple" variant.
      return { id: uid(), type, ...emptyLayout, variant: "brand", accent: "#ea580c", lines: [
        { text: "{{company.name}} — {{company.tagline}}" },
        { text: "{{company.address}} · {{company.phone}}" },
        { text: "{{company.email}} · {{company.website}}" },
      ] };
    case "conditional":
      return { id: uid(), type, ...emptyLayout, when: "", blocks: [] };
    case "handoverChecklist":
      return { id: uid(), type, ...emptyLayout };
    case "showcaseHeader":
      return { id: uid(), type, ...emptyLayout, title: "QUOTATION", docNumber: "{{quote.number}}", tagline: "PREMIUM ELECTRIC MOBILITY", bg: "#020617", accent: "#ea580c", bgImage: "", showLogo: true };
    case "infoStrip":
      return { id: uid(), type, ...emptyLayout, accent: "#ea580c", items: [
        { icon: "calendar", label: "QUOTE DATE", value: "{{quote.date}}", sub: "" },
        { icon: "calendarCheck", label: "VALID UNTIL", value: "{{quote.validUntil}}", sub: "" },
        { icon: "user", label: "PREPARED BY", value: "{{preparedBy}}", sub: "Sales Consultant" },
      ] };
    case "vehicleShowcase":
      return { id: uid(), type, ...emptyLayout, part: "full", brand: "DENAGO EV", accent: "#ea580c", imageHeight: 280, imageFit: "contain" };
    case "totalsBox":
      return { id: uid(), type, ...emptyLayout, bg: "#020617", accent: "#ea580c", totalLabel: "TOTAL INCL. VAT", totalAmount: "{{quote.total}}", rows: [
        { label: "Subtotal (excl. VAT)", value: "{{quote.subtotal}}" },
        // The quote's own rate, as issued — never a figure typed into the layout.
        { label: "VAT ({{quote.vatRate}})", value: "{{quote.vat}}" },
      ] };
    case "acceptance":
      return {
        id: uid(), type, ...emptyLayout, title: "ACCEPTANCE OF QUOTATION",
        text: "I confirm acceptance of the above quotation and {{company.name}}’s terms and conditions.",
        nameLabel: "Customer Name", nameValue: "{{customer.name}}", signatureLabel: "Signature", dateLabel: "Date",
      };
    case "footerBand":
      return { id: uid(), type, ...emptyLayout, subtitle: "{{company.tagline}}", bg: "#020617", accent: "#ea580c", bgImage: "" };
    // Customer email blocks (./emailRender.ts).
    case "emailHeader":
    case "emailBody":
    case "emailSignature":
      return { id: uid(), type, ...emptyLayout };
    case "emailFooter":
      return { id: uid(), type, ...emptyLayout, note: "" };
    case "emailButton":
      return { id: uid(), type, ...emptyLayout, token: "signing_link", label: "Open & sign", style: "dark" };
    case "emailFacts":
      return { id: uid(), type, ...emptyLayout, items: [
        { label: "QUOTE", value: "{{quote_number}}", sub: "", highlight: false },
        { label: "TOTAL INCL. VAT", value: "{{total}}", sub: "", highlight: true },
      ] };
  }
}

/** Composes the branded "Standard" quotation layout as an editable document. */
/**
 * The standard quotation a workspace starts from.
 *
 * `automotive` adds what only a vehicle dealer quotes: the "vehicle of interest"
 * card, the build-slot deposit and the low-speed-vehicle disclaimer. It used to
 * be unconditional — and the disclaimer named Denago — so a breastfeeding-art
 * studio's quotes told its customers about "Denago EVs". Generic by default; the
 * callers pass the workspace's module.
 */
export function standardQuoteTemplate({ automotive = false }: { automotive?: boolean } = {}): DocumentModel {
  const meta = (text: string, align: "left" | "center" | "right") => {
    const b = newBlock("text");
    if (b.type === "text") b.value = [{ type: "p", align, children: [{ text }] }];
    return b;
  };
  const infoCard = (label: string, name: string, lines: string, accent: string) => {
    const b = newBlock("infoCard");
    if (b.type === "infoCard") { b.label = label; b.name = name; b.lines = lines; b.accent = accent; }
    return b;
  };
  const total = newBlock("totalBand");
  total.settings = { width: 55, horizontalAlignment: "right" };
  const terms = newBlock("terms");
  if (terms.type === "terms") terms.items = [
    // Tokens, not literals: the validity comes from the quote's own date (set
    // from Settings → Quotes) and the VAT from its own lines, so the wording can
    // never contradict the figures above it.
    { text: "Quote valid until {{quote.validUntil}}." },
    ...(automotive ? [{ text: "50% deposit to secure build slot; balance on delivery." }] : []),
    { text: "Prices are recommended retail, including {{quote.vatRate}} VAT, and subject to change without notice." },
    ...(automotive ? [{ text: "Our EVs are Low-Speed Vehicles for private-property use and are not road registered." }] : []),
    { text: "E&OE." },
  ];

  return {
    schemaVersion: 1,
    title: "Standard quotation",
    style: { fontFamily: "sans", pageSize: "A4", margin: 40, accent: "#ea580c", ink: "#020617" },
    recipients: [],
    pages: [newPage([
      newRow([newColumn(100, [newBlock("banner")])]),
      newRow([
        newColumn(33, [meta("Date: {{quote.date}}", "left")]),
        newColumn(34, [meta("Valid until: {{quote.validUntil}}", "center")]),
        newColumn(33, [meta("Prepared by: {{preparedBy}}", "right")]),
      ]),
      newRow(
        automotive
          ? [
              newColumn(50, [infoCard("PREPARED FOR", "{{customer.name}}", "{{customer.phone}}\n{{customer.email}}", "#ea580c")]),
              newColumn(50, [infoCard("VEHICLE OF INTEREST", "{{vehicle}}", "Demo drives available at your estate or our showroom.", "#020617")]),
            ]
          : [newColumn(100, [infoCard("PREPARED FOR", "{{customer.name}}", "{{customer.phone}}\n{{customer.email}}", "#ea580c")])],
      ),
      newRow([newColumn(100, [newBlock("lineItems")])]),
      newRow([newColumn(100, [total])]),
      newRow([newColumn(100, [terms])]),
      newRow([newColumn(100, [newBlock("footer")])]),
    ])],
    header: [],
    footer: [],
  };
}

export function newOverlayField(kind: OverlayField["kind"], over: Partial<OverlayField> = {}): OverlayField {
  const sized: Record<string, { width: number; height: number }> = {
    signature: { width: 220, height: 72 }, initials: { width: 90, height: 60 }, date: { width: 150, height: 40 },
    text: { width: 200, height: 40 }, checkbox: { width: 32, height: 32 }, radio: { width: 200, height: 80 },
    dropdown: { width: 200, height: 40 }, attachment: { width: 200, height: 56 }, stamp: { width: 120, height: 120 },
  };
  const s = sized[kind] ?? { width: 200, height: 60 };
  return {
    id: uid(), kind, anchor: { mode: "page", blockId: null, x: 64, y: 64 },
    width: s.width, height: s.height, recipientId: null, required: true, label: "", options: kind === "dropdown" || kind === "radio" ? ["Option 1", "Option 2"] : [],
    ...over,
  };
}

export function newRecipient(over: Partial<Recipient> = {}): Recipient {
  const palette = ["#2563eb", "#16a34a", "#db2777", "#9333ea", "#ea580c"];
  return { id: uid(), name: "", email: "", role: "signer", party: "custom", color: palette[Math.floor((Date.now() / 1000) % palette.length)], ...over };
}

/** A fresh single-page A4 proposal with a starter text block. */
export function blankDocument(title = "Untitled proposal"): DocumentModel {
  return {
    schemaVersion: 1,
    title,
    style: { fontFamily: "sans", pageSize: "A4", margin: 48, accent: "#ea580c", ink: "#020617" },
    recipients: [],
    pages: [newPage([newRow([newColumn(100, [newBlock("heading"), newBlock("text")])])])],
    header: [],
    footer: [],
  };
}

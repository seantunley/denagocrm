/** Factories for new document nodes — all with stable UUIDs. */
import type {
  DocumentModel, DocumentPage, DocumentRow, DocumentColumn, DocumentBlock, BlockType,
  OverlayField, Recipient, PricingLine,
} from "./model";

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
        id: uid(), type, ...emptyLayout, currency: "ZAR", bound: false, showTax: true, showDiscount: true, accent: "#ea580c",
        lines: [newPricingLine({ name: "Denago Rover XL", unitPrice: 189900, qty: 1 }), newPricingLine({ name: "On-road & handover", unitPrice: 4500, qty: 1 })],
      };
    case "table":
      return {
        id: uid(), type, ...emptyLayout, headerBg: "#020617", headerColor: "#ffffff",
        columns: [{ header: "Description", align: "left", widthPct: 60 }, { header: "Qty", align: "right", widthPct: 20 }, { header: "Amount", align: "right", widthPct: 20 }],
        rows: [{ cells: [{ value: "Item" }, { value: "1" }, { value: "R 0.00" }] }],
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
      return { id: uid(), type, ...emptyLayout, title: "TERMS", items: [{ text: "Prices include 15% VAT." }] };
    case "footer":
      // Dynamic brand footer — resolves from the editable Company Profile at
      // render time, so it stays correct when company details change.
      return { id: uid(), type, ...emptyLayout, accent: "#ea580c", lines: [
        { text: "{{company.name}} — {{company.tagline}}" },
        { text: "{{company.address}}" },
        { text: "{{company.phone}} · {{company.email}} · {{company.website}}" },
      ] };
    case "conditional":
      return { id: uid(), type, ...emptyLayout, when: "", blocks: [] };
  }
}

/** Composes the branded "Standard" quotation layout as an editable document. */
export function standardQuoteTemplate(): DocumentModel {
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
    { text: "Quote valid for 14 days." },
    { text: "50% deposit to secure build slot; balance on delivery." },
    { text: "Prices are recommended retail, including 15% VAT, and subject to change without notice." },
    { text: "Denago EVs are Low-Speed Vehicles for private-property use and are not road registered." },
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
      newRow([
        newColumn(50, [infoCard("PREPARED FOR", "{{customer.name}}", "{{customer.phone}}\n{{customer.email}}", "#ea580c")]),
        newColumn(50, [infoCard("VEHICLE OF INTEREST", "{{vehicle}}", "Demo drives available at your estate or our Maitland showroom.", "#020617")]),
      ]),
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
  return { id: uid(), name: "", email: "", role: "signer", color: palette[Math.floor((Date.now() / 1000) % palette.length)], ...over };
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

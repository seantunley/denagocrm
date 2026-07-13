import { BLANK_PDF, type Template } from "@pdfme/common";

/**
 * The live CRM documents rebuilt as pdfme templates, used to seed the Designer
 * so it opens with real Denago layouts rather than a blank page. Field values
 * here are the preview/sample inputs (keyed by field name) — swap them for CRM
 * data when generating against a real record.
 *
 * Coordinates are millimetres on a blank A4 (210 × 297). Kept in @/lib (not
 * under a route) so both the seeder and any generator can import it, and NOT
 * named template.ts — that is a reserved Next App Router filename.
 */

const ink = "#020617";
const muted = "#64748b";
const accent = "#ea580c";
const line = "#e2e8f0";

export type PdfmeSeed = {
  key: string;
  name: string;
  template: Template;
  sample: Record<string, string>;
};

/* ── Delivery Note ─────────────────────────────────────────── */
const deliveryNote: PdfmeSeed = {
  key: "delivery",
  name: "Delivery Note",
  template: {
    basePdf: BLANK_PDF,
    schemas: [
      [
        { name: "title", type: "text", content: "DELIVERY NOTE", position: { x: 20, y: 16 }, width: 110, height: 12, fontSize: 22, fontColor: ink, readOnly: true },
        { name: "brand", type: "text", content: "Denago Cape Town · EV", position: { x: 20, y: 29 }, width: 110, height: 6, fontSize: 10, fontColor: muted, readOnly: true },
        { name: "docNumber", type: "text", content: "DN-1042", position: { x: 130, y: 16 }, width: 60, height: 8, fontSize: 13, fontColor: accent, alignment: "right" },
        { name: "docDate", type: "text", content: "12 July 2026", position: { x: 130, y: 25 }, width: 60, height: 6, fontSize: 10, fontColor: muted, alignment: "right" },
        { name: "rule", type: "line", position: { x: 20, y: 40 }, width: 170, height: 0.4, color: line },
        { name: "toLabel", type: "text", content: "DELIVER TO", position: { x: 20, y: 46 }, width: 80, height: 5, fontSize: 8, fontColor: muted, characterSpacing: 1, readOnly: true },
        { name: "customerName", type: "text", content: "Riaan & Co Estate", position: { x: 20, y: 51 }, width: 85, height: 7, fontSize: 12, fontColor: ink },
        { name: "customerAddress", type: "text", content: "14 Vineyard Close\nConstantia, Cape Town 7806", position: { x: 20, y: 58 }, width: 85, height: 16, fontSize: 10, fontColor: ink },
        { name: "vehLabel", type: "text", content: "VEHICLE", position: { x: 115, y: 46 }, width: 75, height: 5, fontSize: 8, fontColor: muted, characterSpacing: 1, readOnly: true },
        { name: "vehicle", type: "text", content: "Denago Rover XL — White", position: { x: 115, y: 51 }, width: 75, height: 7, fontSize: 12, fontColor: ink },
        { name: "vehicleMeta", type: "text", content: "VIN: DNG-XL-002841\nReg: CA 512-994", position: { x: 115, y: 58 }, width: 75, height: 12, fontSize: 10, fontColor: ink },
        {
          name: "checklist", type: "table", position: { x: 20, y: 82 }, width: 170, height: 45,
          content: JSON.stringify([
            ["Battery fully charged", "Done"],
            ["Tyres & pressure checked", "Done"],
            ["Controls, lights & horn tested", "Done"],
            ["Charger, keys & manual handed over", "Done"],
          ]),
          showHead: true, head: ["Handover item", "Status"], headWidthPercentages: [76, 24],
          tableStyles: { borderWidth: 0.3, borderColor: line },
          headStyles: { fontSize: 10, fontColor: "#ffffff", backgroundColor: ink, borderWidth: 0, padding: { top: 3, right: 4, bottom: 3, left: 4 } },
          bodyStyles: { fontSize: 10, fontColor: ink, borderColor: line, borderWidth: 0.2, padding: { top: 3, right: 4, bottom: 3, left: 4 } },
          columnStyles: { alignment: { "1": "center" } },
        },
        { name: "notesLabel", type: "text", content: "NOTES", position: { x: 20, y: 200 }, width: 80, height: 5, fontSize: 8, fontColor: muted, characterSpacing: 1, readOnly: true },
        { name: "notes", type: "text", content: "Delivered fully charged. Customer walked through charging and safety. Warranty registered on handover.", position: { x: 20, y: 205 }, width: 170, height: 16, fontSize: 10, fontColor: ink },
        { name: "custSigLabel", type: "text", content: "Customer signature · Date", position: { x: 20, y: 250 }, width: 80, height: 5, fontSize: 9, fontColor: muted, readOnly: true },
        { name: "customerSignature", type: "signature", position: { x: 20, y: 232 }, width: 75, height: 16 },
        { name: "staffSigLabel", type: "text", content: "For Denago Cape Town · Date", position: { x: 115, y: 250 }, width: 80, height: 5, fontSize: 9, fontColor: muted, readOnly: true },
        { name: "staffSignature", type: "signature", position: { x: 115, y: 232 }, width: 75, height: 16 },
        { name: "footer", type: "text", content: "Denago Cape Town  ·  crm.denagocpt.co.za  ·  Thank you for choosing electric.", position: { x: 20, y: 285 }, width: 170, height: 5, fontSize: 8, fontColor: muted, alignment: "center", readOnly: true },
      ],
    ],
  },
  sample: {
    docNumber: "DN-1042", docDate: "12 July 2026",
    customerName: "Riaan & Co Estate", customerAddress: "14 Vineyard Close\nConstantia, Cape Town 7806",
    vehicle: "Denago Rover XL — White", vehicleMeta: "VIN: DNG-XL-002841\nReg: CA 512-994",
    notes: "Delivered fully charged. Customer walked through charging and safety. Warranty registered on handover.",
    customerSignature: "", staffSignature: "",
  },
};

/* ── Quotation (converted from the live QuotePrintDoc layout) ── */
const quotation: PdfmeSeed = {
  key: "quote",
  name: "Quotation",
  template: {
    basePdf: BLANK_PDF,
    schemas: [
      [
        // Brand banner
        { name: "banner", type: "rectangle", position: { x: 20, y: 14 }, width: 170, height: 22, color: ink, borderWidth: 0, radius: 3 },
        { name: "brand", type: "text", content: "Denago Cape Town — EV", position: { x: 26, y: 22 }, width: 90, height: 8, fontSize: 13, fontColor: "#ffffff", readOnly: true },
        { name: "title", type: "text", content: "QUOTATION", position: { x: 120, y: 18 }, width: 64, height: 9, fontSize: 20, fontColor: "#ffffff", alignment: "right", characterSpacing: 2, readOnly: true },
        { name: "docNumber", type: "text", content: "Q-1042", position: { x: 120, y: 27 }, width: 64, height: 6, fontSize: 12, fontColor: accent, alignment: "right" },
        // Meta strip
        { name: "metaDate", type: "text", content: "Date: 12 July 2026", position: { x: 20, y: 40 }, width: 60, height: 5, fontSize: 9, fontColor: muted },
        { name: "metaValid", type: "text", content: "Valid until: 26 July 2026", position: { x: 80, y: 40 }, width: 55, height: 5, fontSize: 9, fontColor: muted, alignment: "center" },
        { name: "metaBy", type: "text", content: "Prepared by: Sean", position: { x: 135, y: 40 }, width: 55, height: 5, fontSize: 9, fontColor: muted, alignment: "right" },
        // Customer + vehicle blocks
        { name: "custBox", type: "rectangle", position: { x: 20, y: 48 }, width: 82, height: 26, color: "#f8fafc", borderColor: accent, borderWidth: 0.6, radius: 2 },
        { name: "custLabel", type: "text", content: "PREPARED FOR", position: { x: 24, y: 51 }, width: 74, height: 4, fontSize: 7, fontColor: accent, characterSpacing: 1, readOnly: true },
        { name: "customerName", type: "text", content: "Riaan & Co Estate", position: { x: 24, y: 55.5 }, width: 74, height: 6, fontSize: 11, fontColor: ink },
        { name: "customerContact", type: "text", content: "082 555 1042 · estate@riaan.co.za\n14 Vineyard Close, Constantia 7806", position: { x: 24, y: 62 }, width: 74, height: 10, fontSize: 8, fontColor: muted },
        { name: "vehBox", type: "rectangle", position: { x: 108, y: 48 }, width: 82, height: 26, color: "#f8fafc", borderColor: ink, borderWidth: 0.6, radius: 2 },
        { name: "vehLabel", type: "text", content: "VEHICLE OF INTEREST", position: { x: 112, y: 51 }, width: 74, height: 4, fontSize: 7, fontColor: muted, characterSpacing: 1, readOnly: true },
        { name: "vehicle", type: "text", content: "Denago Rover XL", position: { x: 112, y: 55.5 }, width: 74, height: 6, fontSize: 11, fontColor: ink },
        { name: "vehicleMeta", type: "text", content: "Colour: White\nDemo drives at your estate or our Maitland showroom.", position: { x: 112, y: 62 }, width: 74, height: 10, fontSize: 8, fontColor: muted },
        // Line items
        {
          name: "items", type: "table", position: { x: 20, y: 82 }, width: 170, height: 40,
          content: JSON.stringify([
            ["Denago Rover XL — 6-seater golf cart", "1", "R 189,000.00", "R 189,000.00"],
            ["Lithium battery upgrade (105Ah)", "1", "R 24,500.00", "R 24,500.00"],
            ["Delivery & on-site handover (Cape Town)", "1", "R 3,500.00", "R 3,500.00"],
          ]),
          showHead: true, head: ["Description", "Qty", "Unit price", "Total"], headWidthPercentages: [52, 12, 18, 18],
          tableStyles: { borderWidth: 0, borderColor: line },
          headStyles: { fontSize: 8, fontColor: "#ffffff", backgroundColor: ink, borderWidth: 0, characterSpacing: 1, padding: { top: 2.5, right: 3, bottom: 2.5, left: 3 } },
          bodyStyles: { fontSize: 9, fontColor: ink, borderColor: line, borderWidth: 0.2, padding: { top: 2.5, right: 3, bottom: 2.5, left: 3 } },
          columnStyles: { alignment: { "1": "right", "2": "right", "3": "right" } },
        },
        // Total band
        { name: "totalBand", type: "rectangle", position: { x: 110, y: 128 }, width: 80, height: 12, color: accent, borderWidth: 0, radius: 2 },
        { name: "totalLabel", type: "text", content: "TOTAL INCL. VAT", position: { x: 114, y: 131.5 }, width: 34, height: 5, fontSize: 8, fontColor: "#ffffff", characterSpacing: 1, readOnly: true },
        { name: "totalAmount", type: "text", content: "R 217,000.00", position: { x: 146, y: 130.5 }, width: 42, height: 7, fontSize: 13, fontColor: "#ffffff", alignment: "right" },
        // Terms
        { name: "termsLabel", type: "text", content: "TERMS", position: { x: 20, y: 150 }, width: 80, height: 5, fontSize: 8, fontColor: muted, characterSpacing: 1, readOnly: true },
        { name: "terms", type: "text", content: "• Quote valid for 14 days.\n• 50% deposit to secure build slot; balance on delivery.\n• 12-month limited warranty; battery 24 months.\n• Prices include 15% VAT.", position: { x: 20, y: 155 }, width: 170, height: 22, fontSize: 9, fontColor: muted, lineHeight: 1.4 },
        // Signatures
        { name: "custSigLabel", type: "text", content: "Accepted — customer signature & date", position: { x: 20, y: 252 }, width: 80, height: 5, fontSize: 9, fontColor: muted, readOnly: true },
        { name: "customerSignature", type: "signature", position: { x: 20, y: 234 }, width: 75, height: 16 },
        { name: "dealerSigLabel", type: "text", content: "For Denago Cape Town — signature & date", position: { x: 115, y: 252 }, width: 80, height: 5, fontSize: 9, fontColor: muted, readOnly: true },
        { name: "dealerSignature", type: "signature", position: { x: 115, y: 234 }, width: 75, height: 16 },
        // Footer
        { name: "footRule", type: "line", position: { x: 20, y: 282 }, width: 170, height: 0.6, color: accent },
        { name: "footer", type: "text", content: "Denago Cape Town — Authorized Denago EV Dealer  ·  crm.denagocpt.co.za  ·  @denago_capetown", position: { x: 20, y: 285 }, width: 170, height: 5, fontSize: 8, fontColor: muted, alignment: "center", readOnly: true },
      ],
    ],
  },
  sample: {
    docNumber: "Q-1042", metaDate: "Date: 12 July 2026", metaValid: "Valid until: 26 July 2026", metaBy: "Prepared by: Sean",
    customerName: "Riaan & Co Estate", customerContact: "082 555 1042 · estate@riaan.co.za\n14 Vineyard Close, Constantia 7806",
    vehicle: "Denago Rover XL", vehicleMeta: "Colour: White\nDemo drives at your estate or our Maitland showroom.",
    totalAmount: "R 217,000.00",
    terms: "• Quote valid for 14 days.\n• 50% deposit to secure build slot; balance on delivery.\n• 12-month limited warranty; battery 24 months.\n• Prices include 15% VAT.",
    customerSignature: "", dealerSignature: "",
  },
};

/* ── Shared layout helpers ─────────────────────────────────────
   The remaining documents share the same branded A4 skeleton, so we build them
   from small helpers (banner / meta strip / info card / prose box / table /
   totals / signatures / footer). Field objects are plain data; we cast the
   assembled template to pdfme's Template once per document. */

const WHITE = "#ffffff";
type F = Record<string, unknown>;

function banner(title: string, number: string): F[] {
  return [
    { name: "banner", type: "rectangle", position: { x: 20, y: 14 }, width: 170, height: 22, color: ink, borderWidth: 0, radius: 3 },
    { name: "brandName", type: "text", content: "Denago Cape Town — EV", position: { x: 26, y: 22 }, width: 90, height: 8, fontSize: 13, fontColor: WHITE, readOnly: true },
    { name: "docTitle", type: "text", content: title, position: { x: 100, y: 18 }, width: 84, height: 9, fontSize: 16, fontColor: WHITE, alignment: "right", characterSpacing: 1.5, readOnly: true },
    ...(number
      ? [{ name: "docNumber", type: "text", content: number, position: { x: 100, y: 27.5 }, width: 84, height: 6, fontSize: 12, fontColor: accent, alignment: "right" }]
      : []),
  ];
}

function meta(items: string[]): F[] {
  const xs = [20, 80, 135];
  const aligns = ["left", "center", "right"];
  const ws = [60, 55, 55];
  return items.slice(0, 3).map((t, i) => ({
    name: `meta${i}`, type: "text", content: t, position: { x: xs[i], y: 40 }, width: ws[i], height: 5, fontSize: 9, fontColor: muted, alignment: aligns[i], readOnly: true,
  }));
}

function infoCard(id: string, side: "left" | "right", label: string, name: string, details: string, isAccent: boolean): F[] {
  const x = side === "left" ? 20 : 108;
  return [
    { name: `${id}Box`, type: "rectangle", position: { x, y: 46 }, width: 82, height: 28, color: "#f8fafc", borderColor: line, borderWidth: 0.4, radius: 2 },
    { name: `${id}Bar`, type: "rectangle", position: { x, y: 46 }, width: 1.6, height: 28, color: isAccent ? accent : ink, borderWidth: 0 },
    { name: `${id}Label`, type: "text", content: label, position: { x: x + 5, y: 49 }, width: 72, height: 4, fontSize: 7, fontColor: isAccent ? accent : muted, characterSpacing: 1, readOnly: true },
    { name: `${id}Name`, type: "text", content: name, position: { x: x + 5, y: 53.5 }, width: 72, height: 6, fontSize: 11, fontColor: ink },
    { name: `${id}Details`, type: "text", content: details, position: { x: x + 5, y: 60 }, width: 72, height: 12, fontSize: 8, fontColor: muted },
  ];
}

function proseBox(id: string, y: number, h: number, label: string, body: string): F[] {
  return [
    { name: `${id}Box`, type: "rectangle", position: { x: 20, y }, width: 170, height: h, color: "#f8fafc", borderColor: line, borderWidth: 0.4, radius: 2 },
    { name: `${id}Label`, type: "text", content: label, position: { x: 24, y: y + 3 }, width: 120, height: 4, fontSize: 8, fontColor: muted, characterSpacing: 1, readOnly: true },
    { name: `${id}Body`, type: "text", content: body, position: { x: 24, y: y + 8 }, width: 162, height: h - 11, fontSize: 9, fontColor: ink, lineHeight: 1.4 },
  ];
}

function itemsTable(head: string[], widths: number[], rows: string[][], y: number, h: number, aligns: Record<string, string>): F[] {
  return [{
    name: "items", type: "table", position: { x: 20, y }, width: 170, height: h,
    content: JSON.stringify(rows),
    showHead: true, head, headWidthPercentages: widths,
    tableStyles: { borderWidth: 0, borderColor: line },
    headStyles: { fontSize: 8, fontColor: WHITE, backgroundColor: ink, borderWidth: 0, characterSpacing: 0.5, padding: { top: 2.5, right: 3, bottom: 2.5, left: 3 } },
    bodyStyles: { fontSize: 9, fontColor: ink, borderColor: line, borderWidth: 0.2, padding: { top: 2.5, right: 3, bottom: 2.5, left: 3 } },
    columnStyles: { alignment: aligns },
  }];
}

function totalBand(y: number, label: string, amount: string): F[] {
  return [
    { name: "totalBand", type: "rectangle", position: { x: 110, y }, width: 80, height: 12, color: accent, borderWidth: 0, radius: 2 },
    { name: "totalLabel", type: "text", content: label, position: { x: 114, y: y + 3.5 }, width: 42, height: 5, fontSize: 8, fontColor: WHITE, characterSpacing: 0.5, readOnly: true },
    { name: "totalAmount", type: "text", content: amount, position: { x: 150, y: y + 2.5 }, width: 38, height: 7, fontSize: 13, fontColor: WHITE, alignment: "right" },
  ];
}

function sigs(leftLabel: string, rightLabel: string | null): F[] {
  const f: F[] = [
    { name: "leftSignature", type: "signature", position: { x: 20, y: 234 }, width: 75, height: 15 },
    { name: "leftSigLine", type: "line", position: { x: 20, y: 250 }, width: 75, height: 0.4, color: muted },
    { name: "leftSigLabel", type: "text", content: leftLabel, position: { x: 20, y: 252 }, width: 80, height: 5, fontSize: 9, fontColor: muted, readOnly: true },
  ];
  if (rightLabel) {
    f.push(
      { name: "rightSignature", type: "signature", position: { x: 115, y: 234 }, width: 75, height: 15 },
      { name: "rightSigLine", type: "line", position: { x: 115, y: 250 }, width: 75, height: 0.4, color: muted },
      { name: "rightSigLabel", type: "text", content: rightLabel, position: { x: 115, y: 252 }, width: 80, height: 5, fontSize: 9, fontColor: muted, readOnly: true },
    );
  }
  return f;
}

function footer(): F[] {
  return [
    { name: "footRule", type: "line", position: { x: 20, y: 281 }, width: 170, height: 0.6, color: accent },
    { name: "footer", type: "text", content: "Denago Cape Town — Authorized Denago EV Dealer  ·  Unit 55, M5 Freeway Business Park, Maitland  ·  sales@denagocpt.co.za · denagocpt.co.za", position: { x: 20, y: 285 }, width: 170, height: 6, fontSize: 7.5, fontColor: muted, alignment: "center", readOnly: true },
  ];
}

/** Assemble one document; sample keeps the signature inputs blank (all other
 *  fields fall back to their schema content when previewed). */
function makeDoc(key: string, name: string, fields: F[]): PdfmeSeed {
  return {
    key,
    name,
    template: { basePdf: BLANK_PDF, schemas: [fields] } as unknown as Template,
    sample: { leftSignature: "", rightSignature: "" },
  };
}

const CUSTOMER_DETAILS = "082 555 1042 · estate@riaan.co.za\n14 Vineyard Close, Constantia 7806";
const ITEM_ROWS: string[][] = [
  ["Denago Rover XL — 6-seater golf cart", "1", "R 189,000.00", "R 189,000.00"],
  ["Lithium battery upgrade (105Ah)", "1", "R 24,500.00", "R 24,500.00"],
  ["Delivery & on-site handover (Cape Town)", "1", "R 3,500.00", "R 3,500.00"],
];

/* ── Tax Invoice ──────────────────────────────────────────────── */
const invoice = makeDoc("invoice", "Tax Invoice", [
  ...banner("TAX INVOICE", "INV-1042"),
  ...meta(["Date: 12 July 2026", "Reference: Q-1042", "Billed to: Riaan & Co Estate"]),
  ...infoCard("bill", "left", "BILLED TO", "Riaan & Co Estate", CUSTOMER_DETAILS, true),
  ...infoCard("inv", "right", "INVOICE DETAILS", "Invoice INV-1042", "Quote Q-1042\nStatus: Sent", false),
  ...itemsTable(["Description", "Qty", "Unit price", "Total"], [52, 12, 18, 18], ITEM_ROWS, 80, 36, { "1": "right", "2": "right", "3": "right" }),
  ...totalBand(122, "TOTAL INCL. VAT", "R 217,000.00"),
  ...proseBox("bank", 142, 40, "PAYMENT DETAILS", "Bank: First National Bank\nAccount name: Denago Cape Town\nAccount number: 6250 1234 567\nBranch code: 250655\nReference: INV-1042\n\nPayment due within 7 days of the invoice date. Prices include 15% VAT."),
  ...sigs("Received by · Date", null),
  ...footer(),
]);

/* ── Sales Agreement ──────────────────────────────────────────── */
const agreement = makeDoc("agreement", "Sales Agreement", [
  ...banner("SALES AGREEMENT", "SA-1042"),
  ...meta(["Date: 12 July 2026", "Reference: Q-1042", ""]),
  ...infoCard("buyer", "left", "PURCHASER", "Riaan & Co Estate", CUSTOMER_DETAILS, true),
  ...infoCard("seller", "right", "SELLER", "Denago Cape Town", "Authorized Denago EV Dealer\nUnit 55, M5 Freeway Business Park, Maitland", false),
  ...itemsTable(["Description", "Qty", "Unit price", "Total"], [52, 12, 18, 18], ITEM_ROWS, 80, 34, { "1": "right", "2": "right", "3": "right" }),
  ...totalBand(120, "PURCHASE PRICE", "R 217,000.00"),
  ...proseBox("terms", 140, 46, "TERMS OF SALE",
    "1. The purchaser agrees to buy the vehicle(s) described above at the stated price.\n" +
    "2. Ownership passes on receipt of full payment.\n" +
    "3. The vehicle carries the manufacturer's warranty as per the warranty schedule.\n" +
    "4. Delivery takes place at the agreed address or at Denago Cape Town, Maitland.\n" +
    "5. This agreement is governed by the laws of the Republic of South Africa."),
  ...sigs("Purchaser signature · Date", "For Denago Cape Town · Date"),
  ...footer(),
]);

/* ── Test-drive Indemnity ─────────────────────────────────────── */
const indemnity = makeDoc("indemnity", "Test-drive Indemnity", [
  ...banner("TEST-DRIVE INDEMNITY", ""),
  ...meta(["Date: 12 July 2026", "Please read and sign before the test drive.", ""]),
  ...infoCard("driver", "left", "DRIVER", "Riaan Bekker", "082 555 1042 · riaan@estate.co.za", true),
  ...infoCard("veh", "right", "VEHICLE", "Denago Rover XL", "Colour: White", false),
  { name: "fillBox", type: "rectangle", position: { x: 20, y: 80 }, width: 170, height: 16, color: "#f8fafc", borderColor: line, borderWidth: 0.4, radius: 2 },
  { name: "fillLabel", type: "text", content: "TO BE COMPLETED BY THE DRIVER", position: { x: 24, y: 82.5 }, width: 120, height: 4, fontSize: 7, fontColor: muted, characterSpacing: 1, readOnly: true },
  { name: "licLabel", type: "text", content: "Driver's licence no.:", position: { x: 24, y: 89 }, width: 40, height: 5, fontSize: 8, fontColor: ink, readOnly: true },
  { name: "licValue", type: "text", content: "", position: { x: 62, y: 89 }, width: 40, height: 5, fontSize: 8, fontColor: ink },
  { name: "licLine", type: "line", position: { x: 62, y: 93 }, width: 40, height: 0.3, color: muted },
  { name: "idLabel", type: "text", content: "ID / passport no.:", position: { x: 112, y: 89 }, width: 36, height: 5, fontSize: 8, fontColor: ink, readOnly: true },
  { name: "idValue", type: "text", content: "", position: { x: 148, y: 89 }, width: 40, height: 5, fontSize: 8, fontColor: ink },
  { name: "idLine", type: "line", position: { x: 148, y: 93 }, width: 40, height: 0.3, color: muted },
  ...proseBox("waiver", 100, 70, "INDEMNITY & WAIVER",
    "I, the undersigned, acknowledge that I am test-driving the vehicle entirely at my own risk. " +
    "I confirm that I hold a valid driver's licence, will follow all instructions given by Denago " +
    "Cape Town staff, and accept liability for any damage caused by my negligence during the test " +
    "drive. Denago Cape Town, its owners and employees are indemnified against any claim for injury, " +
    "loss or damage arising from the test drive, to the fullest extent permitted by law."),
  ...sigs("Driver signature · Date", "For Denago Cape Town · Date"),
  ...footer(),
]);

/* ── Workshop Job Card ────────────────────────────────────────── */
const jobcard = makeDoc("jobcard", "Job Card", [
  ...banner("JOB CARD", "#1042"),
  ...meta(["Opened: 12 July 2026", "Status: In progress", "Completed: —"]),
  ...infoCard("cust", "left", "CUSTOMER", "Riaan & Co Estate", "082 555 1042 · estate@riaan.co.za\n14 Vineyard Close, Constantia 7806", true),
  ...infoCard("jveh", "right", "VEHICLE", "Denago Rover XL — White", "VIN: DNG-XL-002841\nReg: CA 512-994 · 128 km in", false),
  ...proseBox("req", 80, 18, "WORK REQUESTED", "Intermittent loss of power under load; customer reports range dropped to ~30 km. Full diagnostic and battery health check requested."),
  ...itemsTable(["Type", "Description", "Qty", "Unit price", "Total"], [16, 42, 10, 16, 16], [
    ["Labour", "Diagnostic & battery health check", "2", "R 450.00", "R 900.00"],
    ["Part", "Controller relay — 48V", "1", "R 1,250.00", "R 1,250.00"],
    ["Labour", "Fit & test", "1", "R 450.00", "R 450.00"],
  ], 102, 34, { "2": "right", "3": "right", "4": "right" }),
  { name: "totPartsL", type: "text", content: "Parts", position: { x: 120, y: 142 }, width: 30, height: 5, fontSize: 9, fontColor: muted, alignment: "right", readOnly: true },
  { name: "totParts", type: "text", content: "R 1,250.00", position: { x: 152, y: 142 }, width: 36, height: 5, fontSize: 9, fontColor: ink, alignment: "right" },
  { name: "totLabourL", type: "text", content: "Labour", position: { x: 120, y: 148 }, width: 30, height: 5, fontSize: 9, fontColor: muted, alignment: "right", readOnly: true },
  { name: "totLabour", type: "text", content: "R 1,350.00", position: { x: 152, y: 148 }, width: 36, height: 5, fontSize: 9, fontColor: ink, alignment: "right" },
  ...totalBand(156, "TOTAL", "R 2,600.00"),
  ...sigs("Customer signature · Date", "Technician signature · Date"),
  ...footer(),
]);

/* ── Service Report ───────────────────────────────────────────── */
const serviceReport = makeDoc("service-report", "Service Report", [
  ...banner("SERVICE REPORT", "SR-1042"),
  ...meta(["Service date: 12 July 2026", "Technician: Sean", "Job card #1042"]),
  ...infoCard("scust", "left", "CUSTOMER", "Riaan & Co Estate", "082 555 1042 · estate@riaan.co.za", true),
  ...infoCard("sveh", "right", "VEHICLE", "Denago Rover XL", "VIN: DNG-XL-002841\nOdometer: 128 km", false),
  ...proseBox("work", 80, 24, "WORK CARRIED OUT", "Replaced 48V controller relay and re-tested under load. Battery pack balanced; all cells within tolerance. Brakes, lights and tyres inspected — all in good order."),
  ...itemsTable(["Item", "Result", "Notes"], [40, 20, 40], [
    ["Battery health", "Pass", "100% capacity, balanced"],
    ["Controller relay", "Replaced", "48V unit fitted & tested"],
    ["Brakes & tyres", "Pass", "Within spec"],
    ["Lights & horn", "Pass", "All functional"],
  ], 108, 40, { "1": "center" }),
  { name: "nextBox", type: "rectangle", position: { x: 20, y: 156 }, width: 170, height: 14, color: "#fff7ed", borderColor: accent, borderWidth: 0.5, radius: 2 },
  { name: "nextBar", type: "rectangle", position: { x: 20, y: 156 }, width: 1.6, height: 14, color: accent, borderWidth: 0 },
  { name: "nextLabel", type: "text", content: "NEXT SERVICE DUE", position: { x: 25, y: 159 }, width: 60, height: 4, fontSize: 7, fontColor: accent, characterSpacing: 1, readOnly: true },
  { name: "nextValue", type: "text", content: "12 January 2027  or  1,500 km", position: { x: 25, y: 163.5 }, width: 120, height: 5, fontSize: 10, fontColor: ink },
  ...sigs("Customer · Date", "Technician · Date"),
  ...footer(),
]);

/* ── Warranty Claim ───────────────────────────────────────────── */
const warrantyClaim = makeDoc("warranty-claim", "Warranty Claim", [
  ...banner("WARRANTY CLAIM", "WC-1042AB"),
  ...meta(["Claimed: 12 July 2026", "Status: Submitted", ""]),
  ...infoCard("wcust", "left", "CUSTOMER", "Riaan & Co Estate", "082 555 1042 · estate@riaan.co.za", true),
  ...infoCard("wveh", "right", "VEHICLE & WARRANTY", "Denago Rover XL", "VIN: DNG-XL-002841\nPurchased: 3 Feb 2026\nWarranty: 12 months (until 3 Feb 2027)", false),
  ...proseBox("fault", 80, 40, "REPORTED FAULT", "Controller relay failed at ~128 km, causing intermittent power loss under load. Fault confirmed on diagnostic. Vehicle within warranty period; no signs of misuse or unauthorised modification."),
  ...proseBox("resolution", 126, 44, "RESOLUTION", "Controller relay replaced under warranty at no charge to the customer. Part returned to Denago for supplier warranty processing. Vehicle tested and returned to service."),
  ...sigs("Customer · Date", "For Denago Cape Town · Date"),
  ...footer(),
]);

/** Blank A4 starter, offered when creating a template from scratch. */
export const BLANK_TEMPLATE: Template = { basePdf: BLANK_PDF, schemas: [[]] };

export const PDFME_SEEDS: PdfmeSeed[] = [
  quotation,
  invoice,
  agreement,
  deliveryNote,
  indemnity,
  jobcard,
  serviceReport,
  warrantyClaim,
];

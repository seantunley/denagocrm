import { BLANK_PDF, type Template } from "@pdfme/common";

/**
 * PROTOTYPE — current CRM documents rebuilt as pdfme templates so we can feel
 * the drag-drop editor on the REAL layouts. Values are mock (no customer data),
 * supplied at generate time via each doc's `sample`, keyed by field name — in a
 * real integration those named inputs come from the CRM record.
 *
 * NOTE: this file is deliberately NOT named template.ts — that is a reserved
 * Next App Router filename (a route Template wrapper).
 *
 * Coordinates are millimetres on a blank A4 (210 × 297).
 */

const ink = "#020617";
const muted = "#64748b";
const accent = "#ea580c";
const line = "#e2e8f0";

type PdfmeDoc = { label: string; template: Template; sample: Record<string, string> };

/* ── Delivery Note ─────────────────────────────────────────── */
const deliveryNote: PdfmeDoc = {
  label: "Delivery Note",
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
const quotation: PdfmeDoc = {
  label: "Quotation",
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

export const DOC_TEMPLATES: Record<string, PdfmeDoc> = {
  delivery: deliveryNote,
  quote: quotation,
};

export const DOC_KEYS = Object.keys(DOC_TEMPLATES);

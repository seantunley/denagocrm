import { BLANK_PDF, type Template } from "@pdfme/common";

/**
 * PROTOTYPE — a Delivery Note rebuilt as a pdfme template so we can feel the
 * drag-drop WYSIWYG editor. Layout lives here; each dynamic field's VALUE comes
 * from `inputs[name]` at generate time (see `deliveryNoteSample`). In a real
 * integration those named inputs would be fed from the CRM record — the design
 * and the data stay cleanly separated. Sample data is mock (no real customer),
 * so this is POPIA-safe to demo.
 *
 * Coordinates are millimetres on a blank A4 (210 × 297).
 */

const ink = "#020617";
const muted = "#64748b";
const accent = "#ea580c";

export const deliveryNoteTemplate: Template = {
  basePdf: BLANK_PDF,
  schemas: [
    [
      // ── Header ──────────────────────────────────────────────
      { name: "title", type: "text", content: "DELIVERY NOTE", position: { x: 20, y: 16 }, width: 110, height: 12, fontSize: 22, fontColor: ink, readOnly: true },
      { name: "brand", type: "text", content: "Denago Cape Town · EV", position: { x: 20, y: 29 }, width: 110, height: 6, fontSize: 10, fontColor: muted, readOnly: true },
      { name: "docNumber", type: "text", content: "DN-1042", position: { x: 130, y: 16 }, width: 60, height: 8, fontSize: 13, fontColor: accent, alignment: "right" },
      { name: "docDate", type: "text", content: "12 July 2026", position: { x: 130, y: 25 }, width: 60, height: 6, fontSize: 10, fontColor: muted, alignment: "right" },
      { name: "rule", type: "line", position: { x: 20, y: 40 }, width: 170, height: 0.4, color: "#e2e8f0" },

      // ── Parties ─────────────────────────────────────────────
      { name: "toLabel", type: "text", content: "DELIVER TO", position: { x: 20, y: 46 }, width: 80, height: 5, fontSize: 8, fontColor: muted, characterSpacing: 1, readOnly: true },
      { name: "customerName", type: "text", content: "Riaan & Co Estate", position: { x: 20, y: 51 }, width: 85, height: 7, fontSize: 12, fontColor: ink },
      { name: "customerAddress", type: "text", content: "14 Vineyard Close\nConstantia, Cape Town 7806", position: { x: 20, y: 58 }, width: 85, height: 16, fontSize: 10, fontColor: ink },

      { name: "vehLabel", type: "text", content: "VEHICLE", position: { x: 115, y: 46 }, width: 75, height: 5, fontSize: 8, fontColor: muted, characterSpacing: 1, readOnly: true },
      { name: "vehicle", type: "text", content: "Denago Rover XL — White", position: { x: 115, y: 51 }, width: 75, height: 7, fontSize: 12, fontColor: ink },
      { name: "vehicleMeta", type: "text", content: "VIN: DNG-XL-002841\nReg: CA 512-994", position: { x: 115, y: 58 }, width: 75, height: 12, fontSize: 10, fontColor: ink },

      // ── Handover checklist (dynamic table) ──────────────────
      {
        name: "checklist",
        type: "table",
        position: { x: 20, y: 82 },
        width: 170,
        height: 45,
        content: JSON.stringify([
          ["Battery fully charged", "Done"],
          ["Tyres & pressure checked", "Done"],
          ["Controls, lights & horn tested", "Done"],
          ["Charger, keys & manual handed over", "Done"],
        ]),
        showHead: true,
        head: ["Handover item", "Status"],
        headWidthPercentages: [76, 24],
        tableStyles: { borderWidth: 0.3, borderColor: "#e2e8f0" },
        headStyles: { fontSize: 10, fontColor: "#ffffff", backgroundColor: ink, borderWidth: 0, padding: { top: 3, right: 4, bottom: 3, left: 4 } },
        bodyStyles: { fontSize: 10, fontColor: ink, borderColor: "#e2e8f0", borderWidth: 0.2, padding: { top: 3, right: 4, bottom: 3, left: 4 } },
        columnStyles: { alignment: { "1": "center" } },
      },

      // ── Notes ───────────────────────────────────────────────
      { name: "notesLabel", type: "text", content: "NOTES", position: { x: 20, y: 200 }, width: 80, height: 5, fontSize: 8, fontColor: muted, characterSpacing: 1, readOnly: true },
      { name: "notes", type: "text", content: "Delivered fully charged. Customer walked through charging and safety. Warranty registered on handover.", position: { x: 20, y: 205 }, width: 170, height: 16, fontSize: 10, fontColor: ink },

      // ── Signatures ──────────────────────────────────────────
      { name: "custSigLabel", type: "text", content: "Customer signature · Date", position: { x: 20, y: 250 }, width: 80, height: 5, fontSize: 9, fontColor: muted, readOnly: true },
      { name: "customerSignature", type: "signature", position: { x: 20, y: 232 }, width: 75, height: 16 },
      { name: "staffSigLabel", type: "text", content: "For Denago Cape Town · Date", position: { x: 115, y: 250 }, width: 80, height: 5, fontSize: 9, fontColor: muted, readOnly: true },
      { name: "staffSignature", type: "signature", position: { x: 115, y: 232 }, width: 75, height: 16 },

      // ── Footer ──────────────────────────────────────────────
      { name: "footer", type: "text", content: "Denago Cape Town  ·  crm.denagocpt.co.za  ·  Thank you for choosing electric.", position: { x: 20, y: 285 }, width: 170, height: 5, fontSize: 8, fontColor: muted, alignment: "center", readOnly: true },
    ],
  ],
};

/** Mock CRM values, keyed by field name — what a real integration would inject. */
export const deliveryNoteSample: Record<string, string> = {
  docNumber: "DN-1042",
  docDate: "12 July 2026",
  customerName: "Riaan & Co Estate",
  customerAddress: "14 Vineyard Close\nConstantia, Cape Town 7806",
  vehicle: "Denago Rover XL — White",
  vehicleMeta: "VIN: DNG-XL-002841\nReg: CA 512-994",
  notes: "Delivered fully charged. Customer walked through charging and safety. Warranty registered on handover.",
  customerSignature: "",
  staffSignature: "",
};

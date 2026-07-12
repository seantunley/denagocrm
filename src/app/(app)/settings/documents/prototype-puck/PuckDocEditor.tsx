"use client";

import { Puck, type Config, type Data } from "@measured/puck";
import "@measured/puck/dist/index.css";

/**
 * PROTOTYPE — the Delivery Note as a Puck drag-drop document. Unlike pdfme,
 * every block renders plain HTML/React, so the output flows straight into the
 * app's existing HTML→Chromium PDF pipeline (no second engine). Structured,
 * calculation-critical blocks (the handover checklist here) are rendered from
 * data and expose NO editable fields, so staff can rearrange and re-word the
 * document without breaking the locked parts.
 */

const ink = "#020617";
const muted = "#64748b";
const accent = "#ea580c";
const docBase: React.CSSProperties = { background: "#fff", color: ink, fontFamily: "Arial, Helvetica, sans-serif" };

const config: Config = {
  components: {
    Header: {
      fields: {
        title: { type: "text" },
        subtitle: { type: "text" },
        number: { type: "text" },
      },
      defaultProps: { title: "DELIVERY NOTE", subtitle: "Denago Cape Town · EV", number: "DN-1042" },
      render: ({ title, subtitle, number }) => (
        <div style={{ ...docBase, display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "16px 24px", borderBottom: `2px solid ${ink}` }}>
          <div>
            <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: 1 }}>{title}</div>
            <div style={{ fontSize: 12, color: muted, marginTop: 2 }}>{subtitle}</div>
          </div>
          <div style={{ fontSize: 15, fontWeight: 700, color: accent }}>{number}</div>
        </div>
      ),
    },
    Parties: {
      fields: {
        customer: { type: "textarea" },
        vehicle: { type: "textarea" },
      },
      defaultProps: {
        customer: "Riaan & Co Estate\n14 Vineyard Close, Constantia 7806",
        vehicle: "Denago Rover XL — White\nVIN: DNG-XL-002841 · Reg: CA 512-994",
      },
      render: ({ customer, vehicle }) => (
        <div style={{ ...docBase, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, padding: "16px 24px" }}>
          <div>
            <div style={{ fontSize: 8, letterSpacing: 1, color: muted, marginBottom: 4 }}>DELIVER TO</div>
            <div style={{ fontSize: 12, whiteSpace: "pre-line" }}>{customer}</div>
          </div>
          <div>
            <div style={{ fontSize: 8, letterSpacing: 1, color: muted, marginBottom: 4 }}>VEHICLE</div>
            <div style={{ fontSize: 12, whiteSpace: "pre-line" }}>{vehicle}</div>
          </div>
        </div>
      ),
    },
    // Locked, data-driven block — no editable fields, so it can't be broken.
    HandoverChecklist: {
      render: () => {
        const rows = [
          ["Battery fully charged", "Done"],
          ["Tyres & pressure checked", "Done"],
          ["Controls, lights & horn tested", "Done"],
          ["Charger, keys & manual handed over", "Done"],
        ];
        return (
          <div style={{ ...docBase, padding: "8px 24px 16px" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <thead>
                <tr style={{ background: ink, color: "#fff" }}>
                  <th style={{ textAlign: "left", padding: "6px 8px" }}>Handover item</th>
                  <th style={{ textAlign: "center", padding: "6px 8px", width: 90 }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([item, status]) => (
                  <tr key={item} style={{ borderBottom: "1px solid #e2e8f0" }}>
                    <td style={{ padding: "6px 8px" }}>{item}</td>
                    <td style={{ padding: "6px 8px", textAlign: "center" }}>{status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      },
    },
    Notes: {
      fields: { text: { type: "textarea" } },
      defaultProps: { text: "Delivered fully charged. Customer walked through charging and safety. Warranty registered on handover." },
      render: ({ text }) => (
        <div style={{ ...docBase, padding: "8px 24px" }}>
          <div style={{ fontSize: 8, letterSpacing: 1, color: muted, marginBottom: 4 }}>NOTES</div>
          <div style={{ fontSize: 11, whiteSpace: "pre-line" }}>{text}</div>
        </div>
      ),
    },
    Signatures: {
      fields: { left: { type: "text" }, right: { type: "text" } },
      defaultProps: { left: "Customer signature · Date", right: "For Denago Cape Town · Date" },
      render: ({ left, right }) => (
        <div style={{ ...docBase, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 48, padding: "40px 24px 16px" }}>
          {[left, right].map((label, i) => (
            <div key={i}>
              <div style={{ borderTop: `2px solid ${ink}`, paddingTop: 6, fontSize: 11, color: muted }}>{label}</div>
            </div>
          ))}
        </div>
      ),
    },
    Footer: {
      fields: { text: { type: "text" } },
      defaultProps: { text: "Denago Cape Town · crm.denagocpt.co.za · Thank you for choosing electric." },
      render: ({ text }) => (
        <div style={{ ...docBase, borderTop: `2px solid ${accent}`, padding: "10px 24px", fontSize: 9, color: muted, textAlign: "center" }}>{text}</div>
      ),
    },
  },
};

const initialData: Data = {
  root: { props: {} },
  content: [
    { type: "Header", props: { id: "header", title: "DELIVERY NOTE", subtitle: "Denago Cape Town · EV", number: "DN-1042" } },
    { type: "Parties", props: { id: "parties", customer: "Riaan & Co Estate\n14 Vineyard Close, Constantia 7806", vehicle: "Denago Rover XL — White\nVIN: DNG-XL-002841 · Reg: CA 512-994" } },
    { type: "HandoverChecklist", props: { id: "checklist" } },
    { type: "Notes", props: { id: "notes", text: "Delivered fully charged. Customer walked through charging and safety. Warranty registered on handover." } },
    { type: "Signatures", props: { id: "sigs", left: "Customer signature · Date", right: "For Denago Cape Town · Date" } },
    { type: "Footer", props: { id: "footer", text: "Denago Cape Town · crm.denagocpt.co.za · Thank you for choosing electric." } },
  ],
};

export default function PuckDocEditor() {
  return (
    <div className="overflow-hidden rounded-xl border border-border" style={{ height: "78vh" }}>
      <Puck
        config={config}
        data={initialData}
        onPublish={() => {
          // In a real integration this Puck data renders to HTML via <Render>,
          // which feeds the existing Chromium→PDF pipeline. No-op in the spike.
        }}
      />
    </div>
  );
}

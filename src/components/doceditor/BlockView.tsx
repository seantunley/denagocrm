"use client";

import type { DocumentBlock } from "@/lib/doceditor/model";
import { computePricing } from "@/lib/doceditor/serialize";
import { ActiveRichText, ReadOnlyRichText } from "./RichText";

function money(amount: number, currency: string): string {
  const n = Math.abs(amount).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === "ZAR" ? `R ${n}` : `${currency} ${n}`;
}

/** Renders one block's CONTENT for the editing canvas. Chrome (handles, outline) is added by the wrapper. */
export function BlockView({ block, active }: { block: DocumentBlock; active: boolean }) {
  switch (block.type) {
    case "text":
    case "heading":
      return active ? <ActiveRichText block={block} /> : <ReadOnlyRichText value={block.value} muted />;

    case "image": {
      const valid = typeof block.src === "string" && /^(https?:|data:image\/)/i.test(block.src.trim());
      return (
        <div style={{ textAlign: "center" }}>
          {valid ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={block.src} alt={block.alt} style={{ width: `${block.widthPct}%`, height: "auto", borderRadius: block.rounded ? 8 : 0 }} />
          ) : (
            <div className="flex items-center justify-center rounded border border-dashed border-slate-300 bg-slate-50 text-slate-400" style={{ height: 120, fontSize: 13 }}>
              🖼 Add an image URL in the panel →
            </div>
          )}
        </div>
      );
    }

    case "divider":
      return <hr style={{ border: "none", borderTop: `${block.thickness}px solid ${block.color}`, margin: "8px 0" }} />;
    case "spacer":
      return <div style={{ height: block.height }} className="rounded bg-slate-50/60" />;
    case "pageBreak":
      return (
        <div className="my-1 flex items-center gap-2 text-[10px] uppercase tracking-wide text-slate-400">
          <span className="h-px flex-1 bg-slate-300" />page break<span className="h-px flex-1 bg-slate-300" />
        </div>
      );

    case "table":
      return (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>{block.columns.map((c, i) => <th key={i} style={{ background: block.headerBg, color: block.headerColor, textAlign: c.align, padding: "5px 7px", fontSize: 10, width: `${c.widthPct}%` }}>{c.header}</th>)}</tr>
          </thead>
          <tbody>
            {block.rows.map((r, ri) => (
              <tr key={ri} style={{ background: ri % 2 ? "#f8fafc" : "#fff" }}>
                {block.columns.map((c, ci) => <td key={ci} style={{ textAlign: c.align, padding: "5px 7px", borderBottom: ".5px solid #e2e8f0" }}>{r.cells[ci]?.value ?? ""}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      );

    case "pricing": {
      const { rows, subtotal, taxTotal, total } = computePricing(block);
      return (
        <div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr>
                {["Item", "Qty", "Unit", block.showDiscount ? "Disc" : null, block.showTax ? "Tax" : null, "Amount"].filter(Boolean).map((h, i) => (
                  <th key={i} style={{ background: block.accent, color: "#fff", textAlign: i === 0 ? "left" : "right", padding: "6px 8px", fontSize: 9, textTransform: "uppercase" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.line.id} style={{ background: i % 2 ? "#f8fafc" : "#fff" }}>
                  <td style={{ padding: "6px 8px", borderBottom: ".5px solid #e2e8f0" }}>
                    <div style={{ fontWeight: 600, color: "#020617" }}>{r.line.name}</div>
                    {r.line.description ? <div style={{ fontSize: 10, color: "#64748b" }}>{r.line.description}</div> : null}
                  </td>
                  <td style={{ textAlign: "right", padding: "6px 8px", borderBottom: ".5px solid #e2e8f0" }}>{r.line.qty}</td>
                  <td style={{ textAlign: "right", padding: "6px 8px", borderBottom: ".5px solid #e2e8f0" }}>{money(r.line.unitPrice, block.currency)}</td>
                  {block.showDiscount ? <td style={{ textAlign: "right", padding: "6px 8px", borderBottom: ".5px solid #e2e8f0" }}>{r.line.discountPct || 0}%</td> : null}
                  {block.showTax ? <td style={{ textAlign: "right", padding: "6px 8px", borderBottom: ".5px solid #e2e8f0" }}>{money(r.tax, block.currency)}</td> : null}
                  <td style={{ textAlign: "right", padding: "6px 8px", borderBottom: ".5px solid #e2e8f0", fontWeight: 600 }}>{money(r.total, block.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
            <table style={{ fontSize: 12 }}>
              <tbody>
                <tr><td style={{ padding: "1px 10px", color: "#64748b" }}>Subtotal</td><td style={{ textAlign: "right" }}>{money(subtotal, block.currency)}</td></tr>
                {block.showTax ? <tr><td style={{ padding: "1px 10px", color: "#64748b" }}>Tax</td><td style={{ textAlign: "right" }}>{money(taxTotal, block.currency)}</td></tr> : null}
                <tr><td style={{ padding: "4px 10px", fontWeight: 700, color: block.accent }}>Total</td><td style={{ textAlign: "right", fontWeight: 700, color: block.accent }}>{money(total, block.currency)}</td></tr>
              </tbody>
            </table>
          </div>
          {block.bound ? <div style={{ fontSize: 10, color: block.accent, marginTop: 4 }}>🔗 Lines auto-fill from the linked record on generate</div> : null}
        </div>
      );
    }

    case "banner":
      return (
        <div style={{ background: block.bg, borderRadius: 8, padding: "14px 18px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          {block.showLogo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src="/branding/denago-logo-email.png" alt="Denago" style={{ height: 32, width: "auto" }} />
          ) : <span style={{ color: "#fff", fontWeight: 800, letterSpacing: 1 }}>DENAGO</span>}
          <div style={{ textAlign: "right" }}>
            <div style={{ color: "#fff", fontWeight: 800, fontSize: 20, letterSpacing: 1 }}>{block.title}</div>
            <div style={{ color: block.accent, fontWeight: 800 }}>{block.docNumber}</div>
          </div>
        </div>
      );
    case "infoCard":
      return (
        <div style={{ background: "#f8fafc", borderLeft: `3px solid ${block.accent}`, borderRadius: 6, padding: "10px 12px" }}>
          <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: 1, color: block.accent }}>{block.label}</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#020617", margin: "2px 0" }}>{block.name}</div>
          <div style={{ fontSize: 11, color: "#64748b", whiteSpace: "pre-wrap" }}>{block.lines}</div>
        </div>
      );
    case "lineItems": {
      const sample: Record<string, string> = { description: "Denago EV Rover XL", qty: "1", unitPrice: "R 235 000,00", unitPriceExVat: "R 204 347,83", vat: "R 30 652,17", subtotal: "R 204 347,83", total: "R 235 000,00" };
      return (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead><tr>{block.columns.map((c, i) => <th key={i} style={{ background: block.headerBg, color: block.headerColor, textAlign: c.align, padding: "6px 8px", fontSize: 9, textTransform: "uppercase" }}>{c.header}{c.showIf?.trim() ? <span title={`Only shown when: ${c.showIf}`}> ⌥</span> : null}</th>)}</tr></thead>
          <tbody>
            <tr>{block.columns.map((c, i) => <td key={i} style={{ textAlign: c.align, padding: "6px 8px", borderBottom: ".5px solid #e2e8f0", color: "#64748b" }}>{sample[c.key]}</td>)}</tr>
            <tr><td colSpan={block.columns.length} style={{ padding: "4px 8px", color: "#94a3b8", fontSize: 10 }}>🔗 fills from the linked quote / job card on generate</td></tr>
          </tbody>
        </table>
      );
    }
    case "totalBand":
      return (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <div style={{ background: block.color, color: "#fff", borderRadius: 6, padding: "8px 18px", display: "flex", gap: 14, alignItems: "center" }}>
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1 }}>{block.label}</span>
            <span style={{ fontSize: 16, fontWeight: 800 }}>{block.amount}</span>
          </div>
        </div>
      );
    case "terms":
      return (
        <div style={{ background: "#f8fafc", borderRadius: 6, padding: "10px 12px" }}>
          {block.title ? <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: 1, color: "#64748b", marginBottom: 5 }}>{block.title}</div> : null}
          {block.items.map((it, i) => <div key={i} style={{ fontSize: 11, color: "#64748b", marginBottom: 2 }}>• {it.text}</div>)}
        </div>
      );
    case "footer":
      return (
        <div style={{ borderTop: `1.5px solid ${block.accent}`, paddingTop: 6, textAlign: "center" }}>
          {block.lines.map((l, i) => <div key={i} style={{ fontSize: i === 0 ? 9 : 8, fontWeight: i === 0 ? 700 : 400, color: i === 0 ? "#334155" : "#64748b" }}>{l.text}</div>)}
        </div>
      );

    case "conditional": {
      const badge = block.when?.trim() ? block.when : "always";
      return (
        <div style={{ border: "1px dashed #a855f7", borderRadius: 6, padding: "4px 6px", background: "rgba(168,85,247,0.04)" }}>
          <div style={{ fontSize: 10, color: "#7c3aed", fontWeight: 600, marginBottom: 2 }}>⌥ Shown when: <code>{badge}</code></div>
          {block.blocks.length === 0 ? (
            <div style={{ fontSize: 11, color: "#94a3b8", padding: "6px 2px" }}>Empty — add blocks in the panel</div>
          ) : (
            block.blocks.map((b) => <BlockView key={b.id} block={b} active={false} />)
          )}
        </div>
      );
    }
  }
  return null;
}

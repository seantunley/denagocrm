"use client";

import type { DocumentBlock } from "@/lib/doceditor/model";
import { blockPreviewHtml } from "@/lib/doceditor/serialize";
import { COMPANY_DEFAULTS } from "@/lib/companyBrand";
import { storedFileSrc } from "@/lib/storedFileSrc";
import { imageFrame } from "@/lib/doceditor/imageFrame";
import { tableLook } from "@/lib/doceditor/tableStyle";
import { ActiveRichText, ReadOnlyRichText } from "./RichText";
import { ShowcaseBlockView } from "./ShowcaseBlockView";
import { useDocEditorEnv } from "./EditorContext";
import { useEditor } from "@/lib/doceditor/store";
import { emailBlockPreviewHtml } from "@/lib/doceditor/emailRender";

/**
 * A block drawn by the PRINT renderer, on the editor page.
 *
 * Each of these used to be redrawn by hand here, in pixels where the print uses
 * points: a card, a table or a totals band was about a quarter smaller on the
 * page than on paper, and drifted further with every change made to only one
 * of the two. There is now one drawing. Its settings are in the panel.
 *
 * Our own renderer's escaped, colour-checked markup — the same the PDF prints —
 * with merge fields left as written and the workspace's own logo and details.
 */
function PrintedBlock({ block, hint }: { block: DocumentBlock; hint?: string }) {
  const { logoSrc, companyName, company } = useDocEditorEnv();
  const style = useEditor((s) => s.doc?.style);
  if (!style) return null;
  // A hidden block prints nothing; on the page it stays, dimmed by its wrapper, so it can be shown again.
  const html = blockPreviewHtml({ ...block, hidden: false }, style, { company: { ...COMPANY_DEFAULTS, ...company, name: company?.name || companyName || COMPANY_DEFAULTS.name }, logo: logoSrc || undefined });
  return (
    <>
      <div dangerouslySetInnerHTML={{ __html: html }} />
      {hint ? <div style={{ fontSize: "7.5pt", color: "#94a3b8", marginTop: 2 }}>{hint}</div> : null}
    </>
  );
}

/**
 * A plain table, typed into where it stands.
 *
 * The panel said "Edit table cells inline on the page" and the page drew plain
 * text: once a table was dropped in, its three sample cells could not be changed
 * by any route. Every heading and cell is now a borderless field in place, so
 * the table looks as it prints and is edited by clicking it. Columns, rows and
 * colours are in the panel. Sizes and spacing are the print's (serialize.ts tableHtml).
 */
function TableView({ block }: { block: Extract<DocumentBlock, { type: "table" }> }) {
  const updateBlock = useEditor((s) => s.updateBlock);
  const field: React.CSSProperties = { width: "100%", background: "transparent", border: "none", outline: "none", padding: 0, margin: 0, font: "inherit", color: "inherit" };
  const setHeader = (ci: number, header: string) => updateBlock(block.id, { columns: block.columns.map((c, i) => (i === ci ? { ...c, header } : c)) } as Partial<DocumentBlock>);
  const setCell = (ri: number, ci: number, value: string) => updateBlock(block.id, {
    // A row saved with fewer cells than there are columns is padded as it is typed into.
    rows: block.rows.map((r, i) => (i === ri ? { ...r, cells: block.columns.map((_, c) => (c === ci ? { value } : r.cells[c] ?? { value: "" })) } : r)),
  } as Partial<DocumentBlock>);
  // The same look the print works out (tableStyle.ts): spacing, rules, tinted rows.
  const look = tableLook(block.tableStyle, [6, 8]);
  const rule: React.CSSProperties = look.borders === "grid" ? { border: ".5px solid #e2e8f0" } : look.borders === "none" ? {} : { borderBottom: ".5px solid #e2e8f0" };
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", margin: "6px 0" }}>
      <thead>
        <tr>{block.columns.map((c, ci) => (
          <th key={ci} style={{ background: block.headerBg, color: block.headerColor, textAlign: c.align, padding: look.pad, fontSize: "8pt", width: `${c.widthPct}%` }}>
            <input aria-label={`Column ${ci + 1} heading`} value={c.header} onChange={(e) => setHeader(ci, e.target.value)} style={{ ...field, textAlign: c.align, fontWeight: 700 }} />
          </th>
        ))}</tr>
      </thead>
      <tbody>
        {block.rows.map((r, ri) => r.kind === "group" ? (
          // A group heading: its first cell, across the whole table.
          <tr key={ri} style={{ background: "#f1f5f9" }}>
            <td colSpan={block.columns.length} style={{ padding: look.pad, ...rule, fontSize: "8.5pt", fontWeight: 700, letterSpacing: ".5px", textTransform: "uppercase", color: "#334155" }}>
              <input aria-label={`Row ${ri + 1}, group heading`} value={r.cells[0]?.value ?? ""} placeholder="Group heading" onChange={(e) => setCell(ri, 0, e.target.value)} style={{ ...field, textTransform: "uppercase" }} />
            </td>
          </tr>
        ) : (
          <tr key={ri} style={{ background: r.kind === "subtotal" ? "#fff" : look.rowBg(ri) }}>
            {block.columns.map((c, ci) => (
              <td key={ci} style={{ textAlign: c.align, padding: look.pad, ...rule, fontSize: "10pt", ...(r.kind === "subtotal" ? { fontWeight: 700, borderTop: "1px solid #94a3b8" } : {}) }}>
                <input aria-label={`Row ${ri + 1}, ${c.header || `column ${ci + 1}`}`} value={r.cells[ci]?.value ?? ""} onChange={(e) => setCell(ri, ci, e.target.value)} style={{ ...field, textAlign: c.align }} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Renders one block's CONTENT for the editing canvas. Chrome (handles, outline) is added by the wrapper. */
export function BlockView({ block, active }: { block: DocumentBlock; active: boolean }) {
  const { email } = useDocEditorEnv();
  // In an email, text reads as the email will — its type, sizes and colours, sample details filled in.
  if (email && !active && (block.type === "text" || block.type === "heading")) return <EmailBlockView block={block} />;
  // Shared blocks drawn in the showcase (or classic) style render its HTML, as the PDF does.
  if ((block.type === "infoCard" || block.type === "lineItems" || block.type === "terms") && (block.look === "showcase" || block.look === "classic")) {
    return <ShowcaseBlockView block={block} />;
  }
  switch (block.type) {
    case "text":
    case "heading":
      return active ? <ActiveRichText block={block} /> : <ReadOnlyRichText value={block.value} muted />;

    case "image": {
      // An uploaded image is a private stored ref; the browser reaches it through /api/stored.
      const raw = typeof block.src === "string" ? block.src.trim() : "";
      const src = /^data:image\//i.test(raw) ? raw : storedFileSrc(raw);
      // The same rule the PDF applies (https only), and the same placement: an image
      // sits where the block's text alignment puts it. The page used to centre every
      // image and accept http — so it showed a picture the PDF then moved, or dropped.
      const valid = !!src && /^(https:|data:image\/|\/api\/stored\?)/i.test(src);
      return (
        <div>
          {valid ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt={block.alt} style={{ height: "auto", ...imageFrame(block) }} />
          ) : (
            <div className="flex items-center justify-center rounded border border-dashed border-slate-300 bg-slate-50 text-slate-400" style={{ height: 120, fontSize: 13 }}>
              🖼 Upload an image or add a URL in the panel →
            </div>
          )}
          {block.caption?.trim() ? <div style={{ fontSize: "8.5pt", color: "#64748b", marginTop: 4, lineHeight: 1.35 }}>{block.caption}</div> : null}
        </div>
      );
    }

    // Kept visible on the page: a spacer prints as empty space, a page break as nothing at all.
    case "spacer":
      return <div style={{ height: block.height }} className="rounded bg-slate-50/60" />;
    case "pageBreak":
      return (
        <div className="my-1 flex items-center gap-2 text-[10px] uppercase tracking-wide text-slate-400">
          <span className="h-px flex-1 bg-slate-300" />page break<span className="h-px flex-1 bg-slate-300" />
        </div>
      );

    case "table":
      return <TableView block={block} />;

    case "pricing":
      return <PrintedBlock block={block} hint={block.bound ? "🔗 Lines fill from the linked record when the document is generated" : undefined} />;
    case "lineItems":
      return <PrintedBlock block={block} hint={`🔗 Fills from the linked quote / job card${block.columns.some((c) => c.showIf?.trim()) ? " · some columns show only when their condition is met" : ""}`} />;
    case "divider": case "banner": case "infoCard": case "totalBand": case "terms": case "footer": case "handoverChecklist":
      return <PrintedBlock block={block} />;
    // Details grid, payment schedule, comparison, callout, gallery, QR code: drawn by the print renderer; edited in the panel.
    case "detailsGrid": case "paymentSchedule": case "comparison": case "callout": case "gallery": case "qr":
      return <PrintedBlock block={block} />;

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

    case "showcaseHeader": case "infoStrip": case "vehicleShowcase": case "totalsBox": case "acceptance": case "footerBand":
      return <ShowcaseBlockView block={block} />;

    case "emailHeader": case "emailSignature": case "emailFooter": case "emailButton": case "emailFacts": case "emailBody":
      return <EmailBlockView block={block} />;
  }
  return null;
}

/** A customer-email block, drawn by the email's own renderer with sample details. */
function EmailBlockView({ block }: { block: DocumentBlock }) {
  const { email, companyName } = useDocEditorEnv();
  const doc = useEditor((s) => s.doc);
  if (block.type === "emailBody") {
    return (
      <div className="rounded-lg border-2 border-dashed border-orange-300 bg-orange-50/60 px-4 py-6 text-center text-sm text-orange-800">
        Each message&apos;s own content goes here — its headline, wording and button.
      </div>
    );
  }
  if (!email) return <div className="text-xs text-slate-400">Email block</div>;
  const brand = { ...email.brand, companyName: email.brand.companyName || companyName };
  const fields = { ...email.sample, sender_name: email.sample.sender_name || "Your name" };
  // Our own renderer's escaped markup with sample values; nothing from a record.
  // The frame's colours reach every block: a message's buttons and links take them too.
  const html = emailBlockPreviewHtml(block, fields, brand, email.kind ? email.frame?.doc : doc);
  // The header and footer run edge to edge of the card, as they send — out past the canvas's side margin.
  if (block.type === "emailHeader" || block.type === "emailFooter") {
    const bleed = (doc?.style.margin ?? 0) + 2;
    return <div style={{ margin: `0 -${bleed}px` }} dangerouslySetInnerHTML={{ __html: html || `<div style="padding:16px;text-align:center;font-size:12px;color:#94a3b8;">Footer — nothing to show yet</div>` }} />;
  }
  return <div style={block.type === "emailSignature" ? { paddingBottom: 34 } : undefined} dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * Shared block contract for the document builder. TYPE-ONLY + plain data so it
 * can be imported by both the client editor (Puck) and the server renderer
 * (react-pdf) without either pulling the other's heavy graph.
 *
 * Each block type has a props shape here, an editor definition in
 * ./puckConfig (Puck fields + HTML render) and a PDF renderer in ./renderPdf.
 */

export type Align = "left" | "center" | "right";

export type BannerProps = { title: string; subtitle: string; docNumber: string; bg: string; accent: string; showLogo: boolean; logoWidth: number; titleAlign: Align; titleSize: number; titleFont: string };
export type HeadingProps = { text: string; level: "1" | "2" | "3"; align: Align; color: string };
export type ParagraphProps = { text: string; align: Align; size: number; color: string };
export type DividerProps = { color: string; thickness: number };
export type SpacerProps = { height: number };
export type TwoColProps = {
  leftLabel: string; leftName: string; leftLines: string;
  rightLabel: string; rightName: string; rightLines: string;
  accentLeft: boolean;
};
export type TableCol = { header: string; align: Align; width: number };
export type TableRow = { cells: { value: string }[] };
export type TableProps = { columns: TableCol[]; rows: TableRow[]; headerBg: string; headerColor: string };
/** Line items bound to the linked record (rows injected at generate time). */
export type LineItemsProps = { headerBg: string; headerColor: string };
export type TotalBandProps = { label: string; amount: string; color: string };
export type TermsProps = { title: string; items: { text: string }[] };
export type SignatureProps = { leftLabel: string; rightLabel: string; showRight: boolean };
export type FooterProps = { lines: { text: string }[]; accent: string };
/** Free-form rich-text block (Plate/Slate JSON) — the "type anywhere" freedom. */
export type RichTextProps = { value: unknown[] };
/** Two-column layout with drop-slots + adjustable widths — place blocks side by side. */
export type ColumnsProps = { ratio: string; gap: number; left: unknown; right: unknown };
/** Image — src (URL or data URI), display width and alignment. */
export type ImageProps = { src: string; width: number; align: Align; caption: string; rounded: boolean };
/** Conditional container — its slotted content renders only when `when` is truthy against the record. */
export type ConditionalProps = { when: string; content: unknown };

export type BlockProps = {
  Banner: BannerProps;
  Heading: HeadingProps;
  Paragraph: ParagraphProps;
  Divider: DividerProps;
  Spacer: SpacerProps;
  TwoColumn: TwoColProps;
  Table: TableProps;
  LineItems: LineItemsProps;
  TotalBand: TotalBandProps;
  Terms: TermsProps;
  Signature: SignatureProps;
  Footer: FooterProps;
  PageBreak: Record<string, never>;
  RichText: RichTextProps;
  Columns: ColumnsProps;
  Image: ImageProps;
  Conditional: ConditionalProps;
};

export type BlockType = keyof BlockProps;

/** Puck document data — the persisted template shape. */
export type BuilderData = {
  root?: { props?: Record<string, unknown> };
  content: Array<{ type: string; props: Record<string, unknown> & { id: string } }>;
  zones?: Record<string, unknown>;
};

// Brand palette (matches the rest of the app / the react-pdf spike).
export const INK = "#020617";
export const ACCENT = "#ea580c";
export const SLATE = "#64748b";

/** Starter layout for a new template — a real quote-shaped document, not blank. */
export function starterTemplate(): BuilderData {
  return {
    root: { props: {} },
    content: [
      { type: "Banner", props: { id: "b1", title: "QUOTATION", subtitle: "Authorized Denago EV Dealer", docNumber: "{{quote.number}}", bg: INK, accent: ACCENT, showLogo: true, logoWidth: 72, titleAlign: "left", titleSize: 16, titleFont: "default" } },
      { type: "Spacer", props: { id: "s1", height: 10 } },
      {
        type: "TwoColumn",
        props: {
          id: "tc1",
          leftLabel: "PREPARED FOR", leftName: "{{customer.name}}", leftLines: "{{customer.phone}} · {{customer.email}}\n{{customer.address}}",
          rightLabel: "VEHICLE OF INTEREST", rightName: "{{vehicle}}", rightLines: "Prepared by {{preparedBy}} · Valid until {{quote.validUntil}}",
          accentLeft: true,
        },
      },
      { type: "Spacer", props: { id: "s2", height: 8 } },
      {
        type: "RichText",
        props: {
          id: "rt1",
          value: [
            { type: "p", children: [{ text: "Thank you for choosing to go electric. Please find your quotation below — reach out any time with questions." }] },
          ],
        },
      },
      { type: "Spacer", props: { id: "s2b", height: 6 } },
      { type: "LineItems", props: { id: "li1", headerBg: INK, headerColor: "#ffffff" } },
      { type: "TotalBand", props: { id: "tb1", label: "TOTAL INCL. VAT", amount: "{{quote.total}}", color: ACCENT } },
      { type: "Spacer", props: { id: "s3", height: 12 } },
      {
        type: "Terms",
        props: {
          id: "tm1", title: "TERMS",
          items: [
            { text: "Quote valid for 14 days." },
            { text: "50% deposit to secure build slot; balance on delivery." },
            { text: "12-month limited warranty; battery 24 months." },
            { text: "Prices include 15% VAT." },
          ],
        },
      },
      { type: "Spacer", props: { id: "s4", height: 20 } },
      { type: "Signature", props: { id: "sig1", leftLabel: "Accepted — customer signature & date", rightLabel: "For Denago Cape Town & date", showRight: true } },
      { type: "Spacer", props: { id: "s5", height: 16 } },
      { type: "Footer", props: { id: "f1", accent: ACCENT, lines: [{ text: "Denago Cape Town — Authorized Denago EV Dealer" }, { text: "Unit 55, M5 Freeway Business Park, Maitland · sales@denagocpt.co.za · denagocpt.co.za" }] } },
    ],
    zones: {},
  };
}

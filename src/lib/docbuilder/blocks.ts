/**
 * The RETIRED Puck builder's block contract, kept as the reference for reading
 * templates saved in that format.
 *
 * The editor (./puckConfig) and its renderer (./renderPdf) are gone, replaced by
 * @/lib/doceditor. What survived them is stored data: `DocBuilderTemplate.data`
 * and `DocBuilderVersion.data` rows written before the switch still hold
 * `{ root, zones, content }` trees whose blocks have these prop shapes.
 *
 * So this file is now TYPES ONLY, and it has exactly one consumer:
 * @/lib/doceditor/legacy, which converts those trees to the current
 * DocumentModel on read. Nothing writes this format any more — the factory that
 * did (`starterTemplate`) was removed with the actions that called it.
 *
 * Do not add to it. A new block type belongs in @/lib/doceditor/model.
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
// `cells` drives plain table rendering; the optional numeric fields let a bound
// pricing block recover exact qty/price/discount instead of re-parsing the cells.
export type TableRow = { cells: { value: string }[]; qty?: number; unitPrice?: number; discountPct?: number };
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


/**
 * How a table is drawn, worked out once — for the printed page and the editor
 * page alike. With no style set, every value here is the literal one the
 * tables always used, so a stored document prints byte for byte as it did.
 */
import type { TableStyle } from "./model";

const RULE = ".5px solid #e2e8f0";

/** `basePad`: the table's own cell padding [vertical, horizontal] in px at normal spacing. */
export function tableLook(style: TableStyle, basePad: readonly [number, number]) {
  const k = style?.density === "compact" ? 0.5 : style?.density === "relaxed" ? 1.6 : 1;
  const borders = style?.borders ?? "rows";
  return {
    /** Cell padding, e.g. "6px 8px". */
    pad: `${Math.round(basePad[0] * k)}px ${basePad[1]}px`,
    /** The rule on a body cell, as a CSS declaration ("" for none). */
    cellRule: borders === "grid" ? `border:${RULE}` : borders === "none" ? "" : `border-bottom:${RULE}`,
    borders,
    /** Background of body row `i`. */
    rowBg: (i: number) => (style?.zebra === false ? "#fff" : i % 2 ? "#f8fafc" : "#fff"),
    /** Inline style for <thead> when the heading must NOT repeat on each page ("" = the browser's default: it repeats). */
    thead: style?.repeatHeader === false ? "display:table-row-group" : "",
    /** Inline style prefix for a body <tr>. */
    tr: style?.keepRows ? "break-inside:avoid;" : "",
  };
}

export const TABLE_DENSITIES = [["compact", "Compact"], ["normal", "Normal"], ["relaxed", "Relaxed"]] as const;
export const TABLE_BORDERS = [["rows", "Lines between rows"], ["grid", "Full grid"], ["none", "None"]] as const;

import type { DocumentBlock } from "./model";

/**
 * A block's box and type settings, as CSS — computed ONCE, for every surface.
 *
 * The PDF applied text size and text alignment; the editor page did not, and
 * neither did a block in free placement, on any surface. So what you set, what
 * you saw and what printed were three different things. Both renderers now ask
 * this one function, so they cannot drift apart again: the serializer turns the
 * result into a style string, the editor hands it to React.
 *
 * `placement: "flow"` adds the block's width and where it sits on its row. A
 * block in free placement has its own x / y / width, so only the type settings
 * apply to it.
 */
export type BoxCss = { width?: string; margin?: string; fontSize?: string; textAlign?: "left" | "center" | "right" };

export function blockBoxCss(block: DocumentBlock, placement: "flow" | "floating"): BoxCss {
  const s = block.settings ?? {};
  const out: BoxCss = {};
  if (placement === "flow" && s.width && s.width < 100) {
    out.width = `${s.width}%`;
    out.margin = s.horizontalAlignment === "right" ? "0 0 0 auto" : s.horizontalAlignment === "centre" ? "0 auto" : "0 auto 0 0";
  }
  // In em so it MULTIPLIES the sizes a block sets for itself. totalBand sets its
  // own point sizes from the scale (an inherited em would not reach them), so
  // applying it here as well would square it.
  if (s.fontScale && s.fontScale !== 1 && block.type !== "totalBand") out.fontSize = `${s.fontScale}em`;
  if (s.textAlign) out.textAlign = s.textAlign === "centre" ? "center" : s.textAlign;
  return out;
}

/** The same thing as an inline style string, in a fixed property order (the PDF's existing output, byte for byte). */
export function boxCssText(css: BoxCss): string {
  let style = "";
  if (css.width) style += `width:${css.width};margin:${css.margin};`;
  if (css.fontSize) style += `font-size:${css.fontSize};`;
  if (css.textAlign) style += `text-align:${css.textAlign};`;
  return style;
}

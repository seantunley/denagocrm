import type { DocumentBlock, LayoutSettings } from "./model";
import { isSafeCssColor } from "./css";

/**
 * A block's box and type settings, as CSS — computed ONCE, for every surface.
 *
 * The PDF applied text size and text alignment; the editor page did not, and
 * neither did a block in free placement, on any surface. So what you set, what
 * you saw and what printed were three different things. Both renderers now ask
 * this one function, so they cannot drift apart again: the serializer turns the
 * result into a style string, the editor hands it to React.
 *
 * Two parts, because they live on different boxes:
 *
 *   outer   where the block SITS — its width, its place on the row, the space
 *           above and below it, and where it rests in a taller column. A block
 *           in free placement has its own x / y / width, so it has no outer part.
 *   inner   what the block LOOKS like — padding, fill, border, corners and type.
 *           The same for a flowed and a freely placed block.
 *
 * Every number is clamped and every colour checked here as well as in the
 * schema: this string goes into a style attribute, on the public signing page
 * among other places.
 */

export type BoxCss = {
  outer: { width?: string; margin?: string; marginTop?: string; marginBottom?: string };
  inner: {
    fontSize?: string; textAlign?: "left" | "center" | "right";
    padding?: string; background?: string; border?: string; borderRadius?: string;
    lineHeight?: string; letterSpacing?: string; fontWeight?: string;
  };
};

/**
 * Blocks whose height and inner positions are FIXED, because signing fields or
 * the foot of the sheet are measured against them. Padding or a border would
 * move a signature line off its field, or push a footer onto a second page —
 * so these take type settings only.
 */
export const FIXED_GEOMETRY = new Set<string>(["acceptance", "footerBand", "showcaseHeader", "pageBreak"]);

/** The settings that are a block's LOOK — what "copy style" carries. Where it sits (width, place on the row) is not style. */
export const STYLE_KEYS = ["padding", "margin", "background", "borderColor", "borderWidth", "radius", "fontScale", "textAlign", "fontWeight", "lineHeight", "letterSpacing", "verticalAlignment"] as const satisfies readonly (keyof LayoutSettings)[];

const clamp = (value: unknown, min: number, max: number): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
};
const px = (value: unknown, max: number): number => clamp(value, 0, max) ?? 0;
const WEIGHT: Record<string, string> = { normal: "400", medium: "600", bold: "800" };

export function blockBoxCss(block: DocumentBlock, placement: "flow" | "floating"): BoxCss {
  const s = block.settings ?? {};
  const fixed = FIXED_GEOMETRY.has(block.type);
  const outer: BoxCss["outer"] = {};
  const inner: BoxCss["inner"] = {};

  if (placement === "flow") {
    const top = fixed ? 0 : px(s.margin?.top, 200);
    const bottom = fixed ? 0 : px(s.margin?.bottom, 200);
    const spaced = top > 0 || bottom > 0;
    if (s.width && s.width < 100) {
      outer.width = `${s.width}%`;
      const [left, right] = s.horizontalAlignment === "right" ? ["auto", "0"] : s.horizontalAlignment === "centre" ? ["auto", "auto"] : ["0", "auto"];
      // With no space above or below this is the string the PDF has always emitted.
      outer.margin = spaced ? `${top}px ${right} ${bottom}px ${left}` : s.horizontalAlignment === "right" ? "0 0 0 auto" : s.horizontalAlignment === "centre" ? "0 auto" : "0 auto 0 0";
    } else if (spaced) {
      outer.margin = `${top}px 0 ${bottom}px 0`;
    }
    // Where the block rests when its column is taller than it (a row of columns
    // is as tall as its tallest). An auto margin takes the spare height.
    if (!fixed && s.verticalAlignment === "bottom") outer.marginTop = "auto";
    if (!fixed && s.verticalAlignment === "middle") { outer.marginTop = "auto"; outer.marginBottom = "auto"; }
  }

  // In em so it MULTIPLIES the sizes a block sets for itself. totalBand sets its
  // own point sizes from the scale (an inherited em would not reach them), so
  // applying it here as well would square it.
  if (s.fontScale && s.fontScale !== 1 && block.type !== "totalBand") inner.fontSize = `${s.fontScale}em`;
  if (s.textAlign) inner.textAlign = s.textAlign === "centre" ? "center" : s.textAlign;

  if (!fixed) {
    const p = s.padding;
    if (p && [p.top, p.right, p.bottom, p.left].some((v) => px(v, 200) > 0)) inner.padding = `${px(p.top, 200)}px ${px(p.right, 200)}px ${px(p.bottom, 200)}px ${px(p.left, 200)}px`;
    if (s.background && isSafeCssColor(s.background)) inner.background = s.background;
    const borderWidth = px(s.borderWidth, 12);
    if (borderWidth > 0) inner.border = `${borderWidth}px solid ${s.borderColor && isSafeCssColor(s.borderColor) ? s.borderColor : "#cbd5e1"}`;
    const radius = px(s.radius, 60);
    if (radius > 0) inner.borderRadius = `${radius}px`;
  }
  const lineHeight = clamp(s.lineHeight, 0.8, 3);
  if (lineHeight !== null && s.lineHeight !== undefined) inner.lineHeight = String(lineHeight);
  const letterSpacing = clamp(s.letterSpacing, -2, 10);
  if (letterSpacing !== null && s.letterSpacing !== undefined && letterSpacing !== 0) inner.letterSpacing = `${letterSpacing}px`;
  if (s.fontWeight && WEIGHT[s.fontWeight]) inner.fontWeight = WEIGHT[s.fontWeight];

  return { outer, inner };
}

/** True when a column must become a flex column so a block's vertical alignment has spare height to use. */
export function columnNeedsStretch(blocks: DocumentBlock[]): boolean {
  return blocks.some((b) => !FIXED_GEOMETRY.has(b.type) && (b.settings?.verticalAlignment === "middle" || b.settings?.verticalAlignment === "bottom"));
}

/**
 * The same thing as ONE inline style string (the PDF wraps a block in a single
 * box), in a fixed property order. A block with only the settings that existed
 * before produces the string the PDF has always emitted, byte for byte.
 */
export function boxCssText(css: BoxCss): string {
  const { outer, inner } = css;
  let style = "";
  if (outer.width) style += `width:${outer.width};`;
  if (outer.margin) style += `margin:${outer.margin};`;
  if (inner.fontSize) style += `font-size:${inner.fontSize};`;
  if (inner.textAlign) style += `text-align:${inner.textAlign};`;
  if (outer.marginTop) style += `margin-top:${outer.marginTop};`;
  if (outer.marginBottom) style += `margin-bottom:${outer.marginBottom};`;
  if (inner.padding) style += `padding:${inner.padding};`;
  if (inner.background) style += `background:${inner.background};-webkit-print-color-adjust:exact;print-color-adjust:exact;`;
  if (inner.border) style += `border:${inner.border};`;
  if (inner.borderRadius) style += `border-radius:${inner.borderRadius};`;
  if (inner.border || inner.padding) style += "box-sizing:border-box;";
  if (inner.lineHeight) style += `line-height:${inner.lineHeight};`;
  if (inner.letterSpacing) style += `letter-spacing:${inner.letterSpacing};`;
  if (inner.fontWeight) style += `font-weight:${inner.fontWeight};`;
  return style;
}

/** A block's style, without where it sits — what "copy style" takes and "paste style" applies. */
export function pickStyle(settings: LayoutSettings | undefined): Partial<LayoutSettings> {
  const out: Record<string, unknown> = {};
  for (const key of STYLE_KEYS) if (settings?.[key] !== undefined) out[key] = settings[key];
  return out as Partial<LayoutSettings>;
}

/** Settings with every style removed: the block keeps its width and its place on the row and nothing else. */
export function withoutStyle(settings: LayoutSettings | undefined): LayoutSettings {
  const out: Record<string, unknown> = { ...(settings ?? {}) };
  for (const key of STYLE_KEYS) delete out[key];
  return out as LayoutSettings;
}

/** How many style settings differ from "as designed" — shown on the panel so an override is never invisible. */
export function styleCount(settings: LayoutSettings | undefined): number {
  return Object.keys(pickStyle(settings)).length;
}

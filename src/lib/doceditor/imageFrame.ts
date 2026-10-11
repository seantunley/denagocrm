import type { ImageBlock } from "./model";

/**
 * How an image block's picture is framed — for the PDF and the editor page
 * alike, so a crop set on the page is the crop that prints.
 *
 * An image used to be "as wide as this, as tall as it happens to be". Putting
 * two photos side by side at the same height, or showing the part of a photo
 * that matters, needed an image editor. Now a block can hold a SHAPE (an aspect
 * ratio); the picture fills it (cropped around a focal point) or fits inside
 * it. Nothing is cut from the file: change the shape or the focal point later
 * and the rest of the picture is still there.
 *
 * A block with no shape set frames exactly as it always did.
 */

export const IMAGE_ASPECTS = { "1:1": [1, 1], "4:3": [4, 3], "3:2": [3, 2], "16:9": [16, 9], "3:4": [3, 4], "2:3": [2, 3] } as const;
export type ImageAspect = keyof typeof IMAGE_ASPECTS;
export const IMAGE_ASPECT_LABELS: Record<ImageAspect, string> = {
  "1:1": "Square", "4:3": "Landscape 4:3", "3:2": "Landscape 3:2", "16:9": "Wide 16:9", "3:4": "Portrait 3:4", "2:3": "Portrait 2:3",
};

const pct = (value: unknown, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : fallback;
};

export type ImageFrame = {
  /** Width as a percentage of the block. */
  width: string;
  /** Set only when the block holds a shape. */
  aspectRatio?: string;
  objectFit?: "cover" | "contain";
  objectPosition?: string;
  borderRadius?: string;
};

export function imageFrame(block: Pick<ImageBlock, "widthPct" | "rounded" | "aspect" | "fit" | "focalX" | "focalY">): ImageFrame {
  const frame: ImageFrame = { width: `${Math.max(5, Math.min(100, block.widthPct))}%` };
  const shape = block.aspect && block.aspect !== "original" ? IMAGE_ASPECTS[block.aspect] : null;
  if (shape) {
    frame.aspectRatio = `${shape[0]} / ${shape[1]}`;
    frame.objectFit = block.fit === "contain" ? "contain" : "cover";
    // The focal point only matters when the picture is cropped to fill.
    if (frame.objectFit === "cover") frame.objectPosition = `${pct(block.focalX, 50)}% ${pct(block.focalY, 50)}%`;
  }
  if (block.rounded) frame.borderRadius = "8px";
  return frame;
}

/** As an inline style string. With no shape set this is the string the PDF has always emitted. */
export function imageFrameCss(frame: ImageFrame): string {
  let style = `width:${frame.width};height:auto;`;
  if (frame.aspectRatio) style += `aspect-ratio:${frame.aspectRatio};object-fit:${frame.objectFit};`;
  if (frame.objectPosition) style += `object-position:${frame.objectPosition};`;
  if (frame.borderRadius) style += `border-radius:${frame.borderRadius};`;
  return style;
}

import type { HelpBlock } from "./types";

/**
 * A guide's "On this page" outline and reading time (2026-11-24; the canvas
 * board "Help centre — article"). Pure.
 *
 * A heading's anchor is its POSITION among the guide's blocks (`h-4`), not its
 * words: two headings may read the same, and the renderer and the outline must
 * agree without sharing anything but this file.
 */
export const headingAnchor = (blockIndex: number): string => `h-${blockIndex}`;

export type OutlineItem = { id: string; text: string };

/** The guide's headings, in order, with **bold** marks removed. */
export function outlineOf(body: readonly HelpBlock[]): OutlineItem[] {
  return body.flatMap((block, index) => (block.type === "h" ? [{ id: headingAnchor(index), text: block.text.replace(/\*\*/g, "").trim() }] : []));
}

/** An outline is worth showing from two headings; one is just the title again. */
export const MIN_OUTLINE = 2;

const WORDS_PER_MINUTE = 200;

/** Every word a reader meets in the guide, whatever block it sits in. */
function words(body: readonly HelpBlock[]): number {
  const count = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
  let total = 0;
  for (const block of body) {
    if (block.type === "p" || block.type === "h" || block.type === "callout") total += count(block.text);
    else if (block.type === "steps" || block.type === "list") total += block.items.reduce((sum, item) => sum + count(item), 0);
    else if (block.type === "table") total += [...block.headers, ...block.rows.flat()].reduce((sum, cell) => sum + count(cell), 0);
  }
  return total;
}

/** Minutes to read, counted from the guide's own words at 200 a minute; never less than one. */
export function readingMinutes(body: readonly HelpBlock[]): number {
  return Math.max(1, Math.round(words(body) / WORDS_PER_MINUTE));
}

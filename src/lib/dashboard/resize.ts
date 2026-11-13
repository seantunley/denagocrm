/**
 * Where a card's size snaps to while its corner is dragged.
 *
 * Pure arithmetic on measurements the canvas takes once, at the start of the
 * pull. Nothing here re-measures the card while it moves: the grid reflows as
 * the size changes, the card can wrap to the next row, and a size computed from
 * where the card IS would chase its own reflow. Width is measured from where the
 * card's left edge was when the pull began, so the answer depends on the pointer
 * alone and cannot oscillate.
 *
 * The result is only ever a value the config already allows — 1 to 4 columns,
 * 1 to 4 rows — written through the same `span` and `rows` fields the size
 * buttons in the card's settings write.
 */

export type Size = 1 | 2 | 3 | 4;

/** How far the pointer must travel on an axis before that axis changes at all. */
export const RESIZE_DEAD_ZONE_PX = 24;

/**
 * The height one row stands for, in rem.
 *
 * CARD_MIN_HEIGHT in components/dashboard/cards/placement.ts gives rows 2, 3 and
 * 4 minimums of 22, 33 and 44rem: 11rem a row. Kept as a number here so a test
 * can hold the two together.
 */
export const ROW_UNIT_REM = 11;

const clampSize = (n: number): Size => Math.min(4, Math.max(1, Math.round(n))) as Size;

export type GridMeasure = {
  /** The card's left edge when the pull began. */
  startLeft: number;
  /** The section grid's width and column gap, in px. */
  gridWidth: number;
  gap: number;
  /** How many columns the section grid shows at this screen width. */
  columns: number;
};

/**
 * The span for a card whose right edge is being pulled to `pointerX`.
 *
 * At a screen width where the section shows fewer columns than the card spans,
 * the card is already as wide as it can be. Pulling it to full width there keeps
 * the span it had, so a 4-wide card resized on a 2-column tablet does not come
 * back 2-wide on a desktop.
 */
export function snapSpan(pointerX: number, measure: GridMeasure, current: Size): Size {
  const columns = Math.max(1, Math.min(4, measure.columns));
  const columnWidth = (measure.gridWidth - measure.gap * (columns - 1)) / columns;
  if (columnWidth <= 0) return current;
  const width = pointerX - measure.startLeft;
  const wanted = clampSize(Math.min(columns, (width + measure.gap) / (columnWidth + measure.gap)));
  if (wanted === columns && current >= columns) return current;
  return wanted;
}

/**
 * The rows for a card whose bottom edge is being pulled to `height` px tall.
 *
 * One row is stored as ABSENT, not as 1: absent is "as tall as its content",
 * which is what one row draws as anyway, and config.ts keeps `rows` out of a
 * card nobody has deliberately made taller.
 */
export function snapRows(height: number, rowUnitPx: number): Size | undefined {
  if (rowUnitPx <= 0) return undefined;
  const rows = clampSize(height / rowUnitPx);
  return rows === 1 ? undefined : rows;
}

/** One step of a keyboard resize: the next size up or down, held to 1–4. */
export function stepSize(current: Size, by: -1 | 1): Size {
  return clampSize(current + by);
}

/** "2 × 3" — columns by rows, for the badge shown while pulling. */
export function sizeLabel(span: Size, rows: Size | undefined): string {
  return `${span} × ${rows ?? 1}`;
}

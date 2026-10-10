/**
 * Alignment guides while dragging or resizing something placed on the page — a
 * signing field or a freely placed block.
 *
 * Both layers moved things with no help at all: lining a date up under a
 * signature meant nudging by eye. This hands react-moveable every OTHER placed
 * thing on the same page as a guide, so the one being moved snaps to their
 * edges and centres (within a few pixels) and a line shows what it snapped to.
 * It also snaps to the page's own edges and centre line.
 *
 * Spread into <Moveable {...alignmentGuides(target)} />.
 * ponytail: guides are the other placed things and the sheet. Flowed blocks are
 * not guides — add `[data-block-id]` to the selector if lining up against text
 * turns out to be wanted.
 */
export function alignmentGuides(target: HTMLElement | null) {
  const page = target?.closest<HTMLElement>("[data-page-idx]") ?? null;
  const others = page ? Array.from(page.querySelectorAll<HTMLElement>("[data-field-id], [data-float-id]")).filter((el) => el !== target) : [];
  return {
    snappable: true,
    snapThreshold: 5,
    isDisplaySnapDigit: false,
    snapDirections: { top: true, left: true, bottom: true, right: true, center: true, middle: true },
    elementSnapDirections: { top: true, left: true, bottom: true, right: true, center: true, middle: true },
    elementGuidelines: others,
    // The sheet's left edge, centre and right edge.
    verticalGuidelines: page ? [0, page.clientWidth / 2, page.clientWidth] : [],
  };
}

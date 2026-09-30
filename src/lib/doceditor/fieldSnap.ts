import type { DocumentModel, OverlayField } from "./model";
import { acceptanceFieldRects, acceptanceHeight } from "./showcaseRender";

/** How far outside an acceptance card a field may sit and still be taken as belonging to it. */
const REACH = 40;
const SIGNATURE_KINDS = new Set(["signature", "initials", "stamp"]);

/**
 * Put the signature and date fields that belong to a showcase acceptance card
 * back ON its Signature and Date lines.
 *
 * Overlay fields are page coordinates stored beside the card, not inside it, so
 * nothing keeps the two together: a card nudged in the editor, or a field
 * dragged while the canvas drew the card's content at the wrong scale (fixed in
 * #685, but templates edited before it keep the drift), leaves the customer
 * signing beside the line. The card's geometry is fixed (ACCEPTANCE_GEOMETRY),
 * so where its fields belong is known exactly.
 *
 * Applied at SEND time, before the SignatureField rows are written, so the
 * signer's controls, the stamped signature in the sealed PDF and the snapshot
 * all use the same corrected position. Per card, the nearest signature-kind and
 * nearest date field within REACH px are snapped; anything else is left where
 * its author put it.
 */
export function snapFieldsToAcceptanceCards(doc: DocumentModel): DocumentModel {
  let changed = false;
  const pages = doc.pages.map((page) => {
    const cards = page.floatingBlocks.filter((f) => f.block.type === "acceptance");
    if (!cards.length || !page.overlayFields.length) return page;
    const next = new Map<string, OverlayField>();
    for (const card of cards) {
      const lines = acceptanceFieldRects(card);
      const box = { l: card.x - REACH, t: card.y - REACH, r: card.x + card.width + REACH, b: card.y + acceptanceHeight() + REACH };
      const near = (f: OverlayField) => {
        const cx = f.anchor.x + f.width / 2;
        const cy = f.anchor.y + f.height / 2;
        return f.anchor.mode === "page" && cx >= box.l && cx <= box.r && cy >= box.t && cy <= box.b;
      };
      const distance = (f: OverlayField, target: { x: number; y: number; width: number; height: number }) =>
        Math.hypot(f.anchor.x + f.width / 2 - (target.x + target.width / 2), f.anchor.y + f.height / 2 - (target.y + target.height / 2));
      const nearest = (kinds: (k: string) => boolean, target: { x: number; y: number; width: number; height: number }) =>
        page.overlayFields
          .filter((f) => kinds(f.kind) && near(f) && !next.has(f.id))
          .sort((a, b) => distance(a, target) - distance(b, target))[0];
      for (const [pick, target] of [
        [nearest((k) => SIGNATURE_KINDS.has(k), lines.signature), lines.signature],
        [nearest((k) => k === "date", lines.date), lines.date],
      ] as const) {
        if (!pick) continue;
        const snapped = { ...pick, anchor: { ...pick.anchor, x: target.x, y: target.y }, width: target.width, height: target.height };
        if (snapped.anchor.x !== pick.anchor.x || snapped.anchor.y !== pick.anchor.y || snapped.width !== pick.width || snapped.height !== pick.height) changed = true;
        next.set(pick.id, snapped);
      }
    }
    return next.size ? { ...page, overlayFields: page.overlayFields.map((f) => next.get(f.id) ?? f) } : page;
  });
  return changed ? { ...doc, pages } : doc;
}

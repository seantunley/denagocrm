import type { DocumentModel, OverlayField } from "./model";
import { acceptanceFieldRects } from "./showcaseRender";

/**
 * Snap only a field whose anchor is within this many px of its TARGET slot's
 * anchor on BOTH axes (|dx| ≤ 40 and |dy| ≤ 40). Chosen over "anywhere near the
 * card" so a field the author deliberately placed elsewhere on or around the
 * card is never pulled onto the customer's lines.
 */
export const SNAP_REACH = 40;
const SIGNATURE_KINDS = new Set(["signature", "initials", "stamp"]);

type Slot = { x: number; y: number; width: number; height: number };

/**
 * The signing fields that sit ON an acceptance card's Signature and Date lines
 * right now: for each line, the nearest field of the right kind within
 * SNAP_REACH of it. These are "the card's fields" — the ones that belong with
 * it when it moves.
 *
 * Whoever they are assigned to: a template being built often has them
 * unassigned, and a field sitting on the line is the card's whatever its
 * recipient. (The send-time repair below is stricter on purpose: it only ever
 * moves the customer's.)
 */
export function fieldsOnAcceptanceCard(
  fields: OverlayField[],
  card: { x: number; y: number; width: number },
): { signature: OverlayField | null; date: OverlayField | null } {
  const slots = acceptanceFieldRects(card);
  const taken = new Set<string>();
  const nearest = (slot: Slot, isKind: (kind: string) => boolean): OverlayField | null => {
    const hit = fields
      .filter((f) => !taken.has(f.id) && isKind(f.kind) && f.anchor.mode === "page" && Math.abs(f.anchor.x - slot.x) <= SNAP_REACH && Math.abs(f.anchor.y - slot.y) <= SNAP_REACH)
      .sort((a, b) => Math.hypot(a.anchor.x - slot.x, a.anchor.y - slot.y) - Math.hypot(b.anchor.x - slot.x, b.anchor.y - slot.y))[0] ?? null;
    if (hit) taken.add(hit.id);
    return hit;
  };
  return { signature: nearest(slots.signature, (kind) => SIGNATURE_KINDS.has(kind)), date: nearest(slots.date, (kind) => kind === "date") };
}

/**
 * Move an acceptance card and take its signature and date fields with it.
 *
 * The fields are page coordinates stored beside the card, not inside it, so the
 * editor used to say "if you move this card, move those two fields with it" —
 * and a card moved without them sent the customer to sign beside the line. Now
 * the fields found on the card's lines BEFORE the move are put exactly on its
 * lines AFTER it (a width change moves the lines too). A field that was not on
 * a line stays where its author put it. Returns the page's fields, changed or not.
 */
export function carryAcceptanceFields(
  fields: OverlayField[],
  before: { x: number; y: number; width: number },
  after: { x: number; y: number; width: number },
): OverlayField[] {
  const mine = fieldsOnAcceptanceCard(fields, before);
  if (!mine.signature && !mine.date) return fields;
  const slots = acceptanceFieldRects(after);
  const onto = (f: OverlayField, slot: Slot): OverlayField => ({ ...f, anchor: { ...f.anchor, x: slot.x, y: slot.y }, width: slot.width, height: slot.height });
  return fields.map((f) => (f.id === mine.signature?.id ? onto(f, slots.signature) : f.id === mine.date?.id ? onto(f, slots.date) : f));
}

/**
 * Put the customer's signature and date fields back ON a showcase acceptance
 * card's Signature and Date lines, when they have drifted a little off them.
 *
 * Overlay fields are page coordinates stored beside the card, not inside it, so
 * nothing keeps the two together: a card nudged in the editor, or a field
 * dragged while the canvas drew the card at the wrong scale (fixed in #685, but
 * templates edited before it keep the drift), leaves the customer signing beside
 * the line. The card's geometry is fixed, so its slots are known exactly
 * (acceptanceFieldRects).
 *
 * Deliberately narrow. Per card and per slot (signature line, date line):
 *   - only fields of that slot's kind, page-anchored, and assigned to the
 *     CUSTOMER — the card's signer (a recipient with party "customer");
 *   - only within SNAP_REACH of the slot on both axes;
 *   - only the single nearest such field (Euclidean distance of anchors) moves.
 * Everything else — another recipient's field, a second candidate, a field
 * placed further away — stays exactly where its author put it.
 *
 * Applied at SEND time, before the SignatureField rows are written, so the
 * signer's controls, the sealed PDF's stamps and the snapshot agree.
 */
export function snapFieldsToAcceptanceCards(doc: DocumentModel): DocumentModel {
  const customers = new Set(doc.recipients.filter((r) => r.party === "customer").map((r) => r.id));
  if (!customers.size) return doc;
  let changed = false;
  const pages = doc.pages.map((page) => {
    const cards = page.floatingBlocks.filter((f) => f.block.type === "acceptance");
    if (!cards.length || !page.overlayFields.length) return page;
    const moved = new Map<string, OverlayField>();
    for (const card of cards) {
      const slots = acceptanceFieldRects(card);
      const place = (slot: Slot, isKind: (kind: string) => boolean) => {
        const eligible = page.overlayFields.filter(
          (f) =>
            !moved.has(f.id) &&
            isKind(f.kind) &&
            f.anchor.mode === "page" &&
            f.recipientId !== null &&
            customers.has(f.recipientId) &&
            Math.abs(f.anchor.x - slot.x) <= SNAP_REACH &&
            Math.abs(f.anchor.y - slot.y) <= SNAP_REACH,
        );
        const nearest = eligible.sort(
          (a, b) => Math.hypot(a.anchor.x - slot.x, a.anchor.y - slot.y) - Math.hypot(b.anchor.x - slot.x, b.anchor.y - slot.y),
        )[0];
        if (!nearest) return;
        const snapped = { ...nearest, anchor: { ...nearest.anchor, x: slot.x, y: slot.y }, width: slot.width, height: slot.height };
        if (snapped.anchor.x !== nearest.anchor.x || snapped.anchor.y !== nearest.anchor.y || snapped.width !== nearest.width || snapped.height !== nearest.height) changed = true;
        moved.set(nearest.id, snapped);
      };
      place(slots.signature, (kind) => SIGNATURE_KINDS.has(kind));
      place(slots.date, (kind) => kind === "date");
    }
    return moved.size ? { ...page, overlayFields: page.overlayFields.map((f) => moved.get(f.id) ?? f) } : page;
  });
  return changed ? { ...doc, pages } : doc;
}

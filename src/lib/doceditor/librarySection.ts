import { z } from "zod";
import { blockSchema, floatingBlockSchema, overlayFieldSchema, rowSchema, type DocumentBlock, type DocumentModel, type DocumentRow, type FloatingBlock, type OverlayField } from "./model";
import { newColumn, newRow } from "./factory";
import { fieldsOnAcceptanceCard } from "./fieldSnap";

/**
 * A SECTION in the content library: a whole arrangement, not one block.
 *
 * The library saved exactly one block, so "customer details beside document
 * details" or "the acceptance card with its signature and date" could not be
 * kept — each had to be rebuilt by hand in every layout. A section keeps:
 *
 *   rows     flowed content with its columns, their widths and spacing
 *   floats   freely placed blocks, at their position on the page
 *   fields   signing fields that belong to those floats (an acceptance card's
 *            signature and date), with WHO signs kept as a party — customer,
 *            Denago — not as one document's recipient id
 *
 * Inserting a section COPIES it into the document with fresh ids. Nothing links
 * back: editing or deleting a library item can never change a document that
 * used it, published or signed. That is deliberate, and it is why sections need
 * no versioning.
 */

const partySchema = z.enum(["denago", "customer", "custom"]);
export const libraryFieldSchema = overlayFieldSchema.and(z.object({ party: partySchema.optional() }));
export const librarySectionSchema = z.object({
  rows: z.array(rowSchema).max(40).default([]),
  floats: z.array(floatingBlockSchema).max(20).default([]),
  fields: z.array(libraryFieldSchema).max(40).default([]),
});
export type LibrarySection = z.infer<typeof librarySectionSchema>;
export type LibraryField = OverlayField & { party?: "denago" | "customer" | "custom" };

/** What a library item holds, old (blocks only) or new (a section). */
export const libraryContentSchema = z.object({
  blocks: z.array(blockSchema).default([]),
  section: librarySectionSchema.optional(),
});

/** Every block in a section, flattened — kept beside it so a reader that only knows "blocks" still gets the content. */
export function sectionBlocks(section: LibrarySection): DocumentBlock[] {
  return [...section.rows.flatMap((r) => r.columns.flatMap((c) => c.blocks)), ...section.floats.map((f) => f.block)];
}

/** An item saved before sections existed: its blocks, one full-width row each. */
export function sectionFromBlocks(blocks: DocumentBlock[]): LibrarySection {
  return { rows: blocks.map((b) => newRow([newColumn(100, [b])])), floats: [], fields: [] };
}

export type SaveScope = "block" | "row";

/**
 * The section to save for the selected block.
 *
 *   a flowed block, scope "block"  that block alone
 *   a flowed block, scope "row"    its whole row: every column, widths and spacing
 *   a freely placed block          the block at its position — and, for an
 *                                  acceptance card, the signature and date fields
 *                                  on its lines
 */
export function sectionFromSelection(doc: DocumentModel, blockId: string, scope: SaveScope): LibrarySection | null {
  for (const page of doc.pages) {
    const floated = page.floatingBlocks.find((fb) => fb.block.id === blockId);
    if (floated) {
      const partyOf = (recipientId: string | null) => doc.recipients.find((r) => r.id === recipientId)?.party;
      const mine = floated.block.type === "acceptance" ? fieldsOnAcceptanceCard(page.overlayFields, floated) : { signature: null, date: null };
      const fields: LibraryField[] = [mine.signature, mine.date].filter((f): f is OverlayField => !!f).map((f) => ({ ...f, party: partyOf(f.recipientId) }));
      return { rows: [], floats: [floated as FloatingBlock], fields };
    }
    for (const row of page.rows) {
      for (const col of row.columns) {
        const block = col.blocks.find((b) => b.id === blockId);
        if (block) return { rows: [scope === "row" ? (row as DocumentRow) : newRow([newColumn(100, [block])])], floats: [], fields: [] };
      }
    }
  }
  return null;
}

/** A one-line description for the library list: "2 columns · 3 blocks · 2 signing fields". */
export function describeSection(section: LibrarySection): string {
  const blocks = sectionBlocks(section).length;
  const widest = Math.max(0, ...section.rows.map((r) => r.columns.length));
  const parts = [
    widest > 1 ? `${widest} columns` : null,
    `${blocks} block${blocks === 1 ? "" : "s"}`,
    section.floats.length ? "freely placed" : null,
    section.fields.length ? `${section.fields.length} signing field${section.fields.length === 1 ? "" : "s"}` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

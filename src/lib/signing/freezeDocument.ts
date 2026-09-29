import type { DocumentBlock, DocumentModel } from "@/lib/doceditor/model";
import type { VehicleShowcaseData } from "@/lib/docbuilder/vehicleShowcase";

/** Every block in a document, wherever it sits (flow, conditionals, floating, header/footer). */
function mapBlocks(doc: DocumentModel, fn: (block: DocumentBlock) => DocumentBlock): DocumentModel {
  const walk = (block: DocumentBlock): DocumentBlock => {
    const next = fn(block);
    return next.type === "conditional" ? { ...next, blocks: next.blocks.map(walk) } : next;
  };
  return {
    ...doc,
    header: doc.header.map(walk),
    footer: doc.footer.map(walk),
    pages: doc.pages.map((page) => ({
      ...page,
      rows: page.rows.map((row) => ({ ...row, columns: row.columns.map((col) => ({ ...col, blocks: col.blocks.map(walk) })) })),
      floatingBlocks: page.floatingBlocks.map((fb) => ({ ...fb, block: walk(fb.block) })),
    })),
  };
}

export function hasVehicleShowcase(doc: DocumentModel): boolean {
  let found = false;
  mapBlocks(doc, (block) => {
    if (block.type === "vehicleShowcase") found = true;
    return block;
  });
  return found;
}

/**
 * Freeze the quote's vehicle into every vehicleShowcase block of a signing
 * snapshot — the vehicle counterpart of freezeDocumentGlobals. The showcase is
 * otherwise read LIVE from the Product, so without this an edit to the product
 * (photo, tagline, specs) would change a document mid-signature and the sealed
 * PDF could show a vehicle the customer never saw. `null` freezes "no vehicle",
 * so one added to the product later cannot appear either.
 *
 * The photo is kept only on blocks that draw it, so a details-only block does
 * not carry a second copy of the bytes.
 */
export function freezeVehicleShowcase(doc: DocumentModel, vehicle: VehicleShowcaseData | null): DocumentModel {
  return mapBlocks(doc, (block) => {
    if (block.type !== "vehicleShowcase") return block;
    const frozen = vehicle ? { ...vehicle, specs: vehicle.specs.map((s) => ({ ...s })), image: block.part === "details" ? null : vehicle.image } : null;
    return { ...block, frozen };
  });
}

function replaceStrings(value: unknown, tokens: Record<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, key: string) =>
      Object.prototype.hasOwnProperty.call(tokens, key) ? tokens[key] : whole,
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceStrings(item, tokens));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        replaceStrings(item, tokens),
      ]),
    );
  }
  return value;
}

/**
 * Resolve record-independent values before a signature request is persisted. The
 * frozen snapshot therefore keeps the exact company identity and send date even
 * when settings change before later recipients sign.
 */
export function freezeDocumentGlobals(
  doc: DocumentModel,
  tokens: Record<string, string>,
): DocumentModel {
  return replaceStrings(doc, tokens) as DocumentModel;
}

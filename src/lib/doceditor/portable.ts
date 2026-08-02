import { z } from "zod";
import { documentSchema, type DocumentModel } from "./model";

/**
 * The one export format that can come back in.
 *
 * HTML, email-safe HTML and .doc are all one-way: they are what the document
 * LOOKS like once rendered, with the blocks, recipients, bindings and field
 * placements flattened away. Nothing can reconstruct a template from them —
 * which is why "export" and "import" never met. This carries the document
 * model itself, so a template built for one tenant can be opened and edited in
 * another.
 */
export const PORTABLE_VERSION = 1;

export const portableDocumentSchema = z.object({
  denagoDocument: z.literal(PORTABLE_VERSION),
  exportedAt: z.string().optional(),
  name: z.string().default("Imported document"),
  key: z.string().default("proposal"),
  document: documentSchema,
});

export type PortableDocument = z.infer<typeof portableDocumentSchema>;

export function buildPortableDocument(opts: {
  name: string;
  key: string;
  document: DocumentModel;
  exportedAt: string;
}): PortableDocument {
  return {
    denagoDocument: PORTABLE_VERSION,
    exportedAt: opts.exportedAt,
    name: opts.name,
    key: opts.key,
    document: opts.document,
  };
}

/**
 * Images referenced by URL do not travel — the blob they point at belongs to
 * the tenant that uploaded it, and the importing tenant has no right to read
 * it. Data-URI images are inline and come across intact. Report the difference
 * rather than let a logo silently 404 in the new tenant's document.
 */
export function externalImageCount(doc: DocumentModel): number {
  let count = 0;
  const walk = (blocks: unknown[]) => {
    for (const block of blocks) {
      const item = block as { type?: string; src?: string; blocks?: unknown[] };
      if (item.type === "image" && item.src && !item.src.startsWith("data:")) count += 1;
      if (Array.isArray(item.blocks)) walk(item.blocks);
    }
  };
  for (const page of doc.pages) {
    for (const row of page.rows) for (const column of row.columns) walk(column.blocks);
    walk(page.floatingBlocks.map((floating) => floating.block));
  }
  walk(doc.header);
  walk(doc.footer);
  return count;
}

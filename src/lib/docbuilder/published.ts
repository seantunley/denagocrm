import "server-only";
import { defaultBuilderTemplateId, getLiveBuilderTemplate } from "@/lib/docbuilder/store";
import { readTemplateDocument } from "@/lib/doceditor/legacy";

/**
 * The SAFE SWITCH from a document type's old renderer to the single editor.
 *
 * Returns the default builder template for `key` — its PUBLISHED version, parsed
 * — only once someone has pressed Publish on it. Anything else (never published,
 * no template, unreadable data) is null, and the caller keeps rendering exactly
 * as it did before. Publishing the layout IS the cut-over; nothing else flips it.
 */
export async function publishedBuilderTemplateFor(key: string) {
  const id = await defaultBuilderTemplateId(key);
  if (!id) return null;
  const template = await getLiveBuilderTemplate(id);
  if (template?.publishedVersion == null) return null;
  const read = readTemplateDocument(template.data, template.name);
  return read.status === "ok" ? { ...template, doc: read.doc } : null;
}

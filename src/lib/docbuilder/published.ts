import "server-only";
import { defaultBuilderTemplateId, getLiveBuilderTemplate } from "./store";

/**
 * The live builder template for a document type — but ONLY once its default
 * template has been Published. Null otherwise.
 *
 * This is the switch that moves a document from its old fixed print page to the
 * single editor. A template that was only ever seeded or autosaved is a draft
 * nobody has approved, so the old page keeps printing until someone presses
 * Publish; after that the published version is what prints.
 */
export async function publishedBuilderTemplateFor(key: string) {
  const id = await defaultBuilderTemplateId(key);
  if (!id) return null;
  const template = await getLiveBuilderTemplate(id);
  return template && template.publishedVersion != null ? template : null;
}

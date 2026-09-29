import "server-only";
import { defaultBuilderTemplateId, getLiveBuilderTemplate } from "./store";

/**
 * The live builder template for a document type, but ONLY once its default
 * template has been published. Null means "not switched over yet": the caller
 * keeps printing from its existing renderer, so seeding a layout never changes
 * a document until the owner presses Publish.
 */
export async function publishedBuilderTemplateFor(key: string) {
  const id = await defaultBuilderTemplateId(key);
  if (!id) return null;
  const template = await getLiveBuilderTemplate(id);
  return template && template.publishedVersion != null ? template : null;
}

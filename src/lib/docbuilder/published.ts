import "server-only";
import { defaultBuilderTemplateId, getLiveBuilderTemplate } from "./store";
import type { LayoutScope } from "./layoutScope";

/**
 * The live builder template for a document type — but ONLY once its default
 * template has been Published. Null otherwise.
 *
 * This is the switch that moves a document from its old fixed print page to the
 * single editor. A template that was only ever seeded or autosaved is a draft
 * nobody has approved, so the old page keeps printing until someone presses
 * Publish; after that the published version is what prints.
 *
 * With a `scope`, only that workspace's layouts are candidates (./layoutScope.ts).
 */
export async function publishedBuilderTemplateFor(key: string, scope?: LayoutScope) {
  const id = await defaultBuilderTemplateId(key, scope);
  if (!id) return null;
  const template = await getLiveBuilderTemplate(id);
  return template && template.publishedVersion != null ? template : null;
}

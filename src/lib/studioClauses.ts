/**
 * `ReusableBlock` holds two different things: Studio clauses (BlockNote content)
 * and the doc-editor's content library (`contentJson: { kind: "doceditor", … }`,
 * written by actions/doclibrary.ts). Each editor must list only its own — a
 * doc-editor item inserted into a Studio document is not BlockNote content.
 *
 * Pure on purpose (no db import) so tests can load it; the query that uses it
 * is `listStudioClauses` in docTemplateStore.ts.
 */
export function isDocEditorLibraryItem(row: { contentJson: unknown }): boolean {
  const json = row.contentJson;
  return !!json && typeof json === "object" && !Array.isArray(json) && (json as { kind?: unknown }).kind === "doceditor";
}

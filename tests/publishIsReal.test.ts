import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

/**
 * The editor autosaves, and every real document rendered the autosaved draft,
 * so Publish did nothing and half-finished edits reached customers. Real
 * documents now render the PUBLISHED version; only previews use the draft.
 */
const src = (p: string) => readFileSync(p, "utf8");

test("the live loader reads the published snapshot, falling back to the draft only when never published", () => {
  const store = src("src/lib/docbuilder/store.ts");
  const live = store.slice(store.indexOf("export async function getLiveBuilderTemplate"));
  assert.match(live, /publishedVersion == null\) return record/);
  assert.match(live, /docBuilderVersion\.findUnique\(\{\s*where: \{ templateId_version: \{ templateId: id, version: record\.publishedVersion \} \}/);
});

test("quote print, e-signing and filed documents render the published version", () => {
  assert.match(src("src/lib/quotePrintDocument.ts"), /opts\.templateId \? await getBuilderTemplate\(templateId\) : await getLiveBuilderTemplate\(templateId\)/);
  const envelope = src("src/lib/signing/autoEnvelope.ts");
  assert.match(envelope, /await getLiveBuilderTemplate\(templateId\)/);
  assert.doesNotMatch(envelope, /await getBuilderTemplate\(/, "the signed document must never be the draft");
  assert.match(src("src/app/actions/doceditor.ts"), /live: true/);
});

test("the editor shows whether real documents match the screen, and publishes from the top bar", () => {
  const editor = src("src/components/doceditor/DocEditor.tsx");
  assert.match(editor, /publishBuilderVersion\(id\)/);
  assert.match(editor, /"Draft, not live yet"/);
  assert.match(editor, /finally \{\s*setPublishing\(false\)/);
});

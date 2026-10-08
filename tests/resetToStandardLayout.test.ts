import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

/**
 * Seeding never overwrites a template, so existing workspaces keep their first
 * seeded layout. "Reset draft to standard layout" is how they pick up a newer
 * one, and it must never change what customers get.
 */
const action = readFileSync("src/app/actions/docbuilder.ts", "utf8");
const reset = action.slice(action.indexOf("export async function resetBuilderTemplateToStandard"), action.indexOf("/** Restore a prior version"));

test("reset needs a layout this person may edit and a type with a standard layout", () => {
  // docbuilder.manage, or document_templates.manage on the seven old form-editor layouts (layoutAccess.test).
  assert.match(reset, /requireAnyPermission\("docbuilder\.manage", "document_templates\.manage"\)/);
  assert.match(reset, /if \(!\(await canEditLayout\(user, tpl\.key\)\)\)/);
  assert.match(reset, /STANDARD_TEMPLATE_KEYS as string\[\]\)\.includes\(tpl\.key\)/);
});

test("the old draft is always kept in history, in one transaction", () => {
  assert.match(reset, /prisma\.\$transaction\(async \(tx\)/);
  assert.match(reset, /data: tpl\.data as object, label: "Before reset to standard"/);
});

test("reset never flips a document type onto the new renderer", () => {
  // #672–#675 switch a type to this editor when its layout HAS a published
  // version. So the saved old draft is published ONLY for quotes, which already
  // render from this editor (a never-published quote renders its draft live).
  assert.match(action, /const RENDERED_WITHOUT_PUBLISH_SWITCH = new Set\(\["quote"\]\)/);
  assert.match(reset, /const draftIsLive = RENDERED_WITHOUT_PUBLISH_SWITCH\.has\(tpl\.key\) && tpl\.publishedVersion == null/);
  assert.match(reset, /\.\.\.\(draftIsLive \? \{ status: "published", publishedVersion: version \} : \{\}\)/);
  assert.equal((reset.match(/publishedVersion: version/g) ?? []).length, 1, "the only publish is the guarded one");
});

test("the editor offers reset only for types that have a standard layout", () => {
  assert.match(readFileSync("src/app/doc-editor/[id]/page.tsx", "utf8"), /hasStandardLayout=\{\(STANDARD_TEMPLATE_KEYS as string\[\]\)\.includes\(template\.key\)\}/);
  assert.match(readFileSync("src/components/doceditor/VersionHistory.tsx", "utf8"), /\{hasStandardLayout && \(/);
});

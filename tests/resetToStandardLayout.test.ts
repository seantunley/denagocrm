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

test("reset needs docbuilder.manage and a type with a standard layout", () => {
  assert.match(reset, /requirePermission\("docbuilder\.manage"\)/);
  assert.match(reset, /STANDARD_TEMPLATE_KEYS as string\[\]\)\.includes\(tpl\.key\)/);
});

test("a never-published template is published as-is first, so real documents don't change", () => {
  // getLiveBuilderTemplate renders the DRAFT of a never-published template;
  // replacing that draft without this would change live quotes on the spot.
  const publishFirst = reset.indexOf("if (tpl.publishedVersion == null)");
  const replaceDraft = reset.indexOf("data: { data: standard as object }");
  assert.ok(publishFirst > 0 && replaceDraft > publishFirst, "publish the current draft before replacing it");
  assert.match(reset, /data: tpl\.data as object, label: "Before reset to standard"/);
  assert.match(reset, /prisma\.\$transaction\(async \(tx\)/);
});

test("the editor offers reset only for types that have a standard layout", () => {
  assert.match(readFileSync("src/app/doc-editor/[id]/page.tsx", "utf8"), /hasStandardLayout=\{\(STANDARD_TEMPLATE_KEYS as string\[\]\)\.includes\(template\.key\)\}/);
  assert.match(readFileSync("src/components/doceditor/VersionHistory.tsx", "utf8"), /\{hasStandardLayout && \(/);
});

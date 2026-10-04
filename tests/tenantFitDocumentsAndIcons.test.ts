import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { docGroupsForModules, docKeyAvailable } from "../src/lib/docTemplates";

// 2026-10-03, Breastfeeding Art: Document Studio offered job cards, service
// reports and warranty claims; the browser tab showed the platform's icon.

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("automotive documents only for a workspace with the automotive module", () => {
  const without = new Set(["marketing", "automation"]);
  for (const key of ["jobcard", "service-report", "warranty-claim", "indemnity", "delivery"]) {
    assert.equal(docKeyAvailable(key, without), false, key);
    assert.equal(docKeyAvailable(key, new Set(["automotive"])), true, key);
  }
  for (const key of ["quote", "invoice", "agreement", "proposal", "custom"]) {
    assert.equal(docKeyAvailable(key, without), true, key);
  }
  assert.deepEqual(docGroupsForModules(without).map((g) => [g.name, g.keys]), [["Sales", ["quote", "invoice", "agreement"]]]);
  assert.equal(docGroupsForModules(new Set(["automotive"])).length, 3);
});

// Review on #755: hiding them was UI-only. A posted key or a known id still
// created, opened, rendered or exported a module-only template.
test("the module rule is enforced on the server, not just in the Studio list", () => {
  const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  // The shared readers every by-id path and renderer goes through.
  const builderStore = code("src/lib/docbuilder/store.ts");
  const getBuilder = builderStore.slice(builderStore.indexOf("export async function getBuilderTemplate"));
  assert.match(getBuilder.slice(0, 400), /if \(!\(await docKeyEnabled\(record\.key\)\)\) return null;/);
  assert.match(builderStore, /if \(!\(await docKeyEnabled\(key\)\)\) return null;\s*await ensureBuilderSeeded\(\);/);
  assert.match(builderStore, /for \(const key of STANDARD_TEMPLATE_KEYS\) \{\s*if \(!\(await docKeyEnabled\(key\)\)\) continue;/);
  const typedStore = code("src/lib/docTemplateStore.ts");
  assert.match(typedStore, /if \(!rec \|\| !\(await docKeyEnabled\(rec\.docType\)\)\) return null;/);
  assert.match(typedStore, /export async function getDocTemplate[^{]*\{\s*if \(!\(await docKeyEnabled\(key\)\)\) throw/);
  assert.match(typedStore, /export async function listTemplates[^{]*\{\s*if \(!\(await docKeyEnabled\(key\)\)\) return \[\];/);

  // No action or page reads a template by id around those readers.
  for (const file of [
    "src/app/actions/docbuilder.ts",
    "src/app/actions/doceditor.ts",
    "src/app/actions/documents.ts",
    "src/app/(app)/settings/documents/t/[id]/page.tsx",
  ]) {
    assert.doesNotMatch(code(file), /\.(docBuilderTemplate|docTemplateRecord)\.find(Unique|First)\(/, file);
  }

  // Creating one checks the key it was handed.
  const editor = code("src/app/actions/doceditor.ts");
  assert.equal((editor.match(/await docKeyEnabled\(key\)/g) ?? []).length, 2, "create + import");
  assert.match(code("src/app/actions/documents.ts"), /if \(!\(await docKeyEnabled\(docType\)\)\) refuse\(/);
});

test("Document Studio and its builder use the module rule", () => {
  const page = src("src/app/(app)/document-studio/page.tsx");
  assert.match(page, /const docGroups = docGroupsForModules\(enabledModules\);/);
  assert.match(page, /\{docGroups\.map\(\(group\) =>/);
  const builder = src("src/app/(app)/document-studio/builder-section.tsx");
  assert.match(builder, /const docKeys = DOC_KEYS\.filter\(\(key\) => docKeyAvailable\(key, enabledModules\)\);/);
  assert.match(builder, /allTemplates\.filter\(\(template\) => docKeyAvailable\(template\.key, enabledModules\)\)/);
  assert.match(builder, /!automotiveOn \? \[\] : prisma\.jobCard\.findMany/);
});

test("the tab icon and app names are the workspace's", () => {
  assert.match(src("src/lib/tenantBrand.ts"), /return logo \? \{ icon: logo, apple: logo \} : \{ \.\.\.PLATFORM_ICONS \};/);
  assert.match(src("src/app/layout.tsx"), /icons: brandIcons\(brand\),/);
  assert.match(src("src/app/(app)/layout.tsx"), /return \{ title: brand\.displayName, icons: brandIcons\(brand\) \};/);
  const messages = src("src/app/messages/layout.tsx");
  assert.match(messages, /const title = `\$\{brand\.tenantId \? brand\.displayName : PLATFORM_NAME\} Messages`;/);
  for (const file of ["src/app/manifest.ts", "src/app/messages/manifest.webmanifest/route.ts", "src/app/messages/layout.tsx"]) {
    assert.doesNotMatch(src(file).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, ""), /"Denago|Denago Cape Town/, file);
  }
});

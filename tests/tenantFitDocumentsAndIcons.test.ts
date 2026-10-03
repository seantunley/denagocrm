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

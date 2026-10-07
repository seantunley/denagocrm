import assert from "node:assert/strict";
import { test } from "node:test";
import Module, { createRequire } from "node:module";
import { readFileSync } from "node:fs";

/*
 * #791 review: retiring the old form editor (document_templates.manage) must not
 * take away the ability to edit the seven operational documents it managed. The
 * REAL rule, against faked grants: document_templates.manage edits exactly those
 * seven layouts in the one editor; docbuilder.manage edits everything; nothing
 * else widens (the quote layout and custom templates stay docbuilder.manage).
 */

let grants = new Set<string>();
type Loader = (request: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
const loader = Module as unknown as { _load: Loader };
const realLoad = loader._load;
loader._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only") return {};
  const file = (parent?.filename ?? "").replace(/\\/g, "/");
  if (file.endsWith("src/lib/docbuilder/layoutAccess.ts")) {
    if (request === "@/lib/permissions") return { hasPermission: async (_u: unknown, p: string) => grants.has(p), requireAnyPermission: async () => ({ id: "u", role: "member" }) };
    if (request === "next/navigation") return { redirect: () => { throw new Error("REDIRECT"); } };
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;
const { canEditLayout, FORM_EDITOR_KEYS } = createRequire(import.meta.url)("../src/lib/docbuilder/layoutAccess.ts") as typeof import("../src/lib/docbuilder/layoutAccess");

const user = { id: "u", role: "member" } as never;
const SEVEN = ["invoice", "agreement", "delivery", "indemnity", "jobcard", "service-report", "warranty-claim"];
const code = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("document_templates.manage still edits every document the old form editor did — and nothing more", async () => {
  grants = new Set(["document_templates.manage"]);
  assert.deepEqual([...FORM_EDITOR_KEYS].sort(), [...SEVEN].sort());
  for (const key of SEVEN) assert.equal(await canEditLayout(user, key), true, key);
  for (const key of ["quote", "custom"]) assert.equal(await canEditLayout(user, key), false, `${key} stays docbuilder.manage`);
});

test("docbuilder.manage edits every layout; neither permission edits none", async () => {
  grants = new Set(["docbuilder.manage"]);
  for (const key of [...SEVEN, "quote", "custom"]) assert.equal(await canEditLayout(user, key), true, key);
  grants = new Set(["docbuilder.view", "documents.manage"]);
  for (const key of [...SEVEN, "quote", "custom"]) assert.equal(await canEditLayout(user, key), false, key);
});

test("the editor's preview-record picker lists only records the person may see (#791 review)", () => {
  // Opening the editor to document_templates.manage holders opened its picker to
  // people who may hold no quotes or workshop permission: every record list in it
  // is scoped, or its labels leak customer names, quote/job numbers, vehicles.
  const page = code("src/app/doc-editor/[id]/page.tsx");
  const loader = page.slice(page.indexOf("const [quotes, jobCards, leads, claims] = await Promise.all(["), page.indexOf("const records = ["));
  assert.match(loader, /getAccessibleQuoteIds\(user\)\.then\(\(ids\) =>\s*prisma\.quote\.findMany\(\{\s*where: \{ supersededAt: null, \.\.\.scoped\(ids\) \}/);
  assert.match(loader, /getAccessibleJobCardIds\(user\)\.then\(\(ids\) =>\s*prisma\.jobCard\.findMany\(\{\s*where: scoped\(ids\)/);
  assert.match(loader, /getAccessibleLeadIds\(user\)/);
  assert.match(loader, /getAccessibleVehicleIds\(user\)/);
  // No record table is read in there except behind its scope helper.
  assert.equal((loader.match(/prisma\.\w+\.findMany/g) ?? []).length, 4);
  assert.equal((loader.match(/getAccessible\w+Ids\(user\)\.then/g) ?? []).length, 4, "each of the four lists behind its scope");
});

test("every way into editing a layout goes through the same rule", () => {
  // The editor page: open to either permission, then this layout's rule.
  const page = code("src/app/doc-editor/[id]/page.tsx");
  assert.match(page, /await requireAnyPermission\("docbuilder\.manage", "document_templates\.manage"\);[\s\S]*const user = await requireLayoutEditor\(template\.key\);/);
  assert.doesNotMatch(page, /requirePermission\("docbuilder\.manage"\)/);
  // Save, image upload, publish, reset, restore, history.
  const editor = code("src/app/actions/doceditor.ts");
  assert.match(editor, /if \(!\(await canEditLayout\(user, existing\.key\)\)\) return \{ ok: false/);
  assert.match(editor, /template \? await canEditLayout\(user, template\.key\) : await hasPermission\(user, "docbuilder\.manage"\)/);
  const builder = code("src/app/actions/docbuilder.ts");
  assert.match(builder, /if \(!\(await canEditLayout\(user, found\.key\)\)\) return \{ ok: false \};/, "publish");
  assert.equal((builder.match(/if \(!\(await canEditLayout\(user, tpl\.key\)\)\)/g) ?? []).length, 2, "reset, restore");
  assert.match(builder, /if \(!\(await hasPermission\(user, "docbuilder\.view"\)\) && !\(await canEditLayout\(user, tpl\.key\)\)\) return \[\];/, "history");
  // The editor's own PDF preview and export.
  for (const route of ["src/app/api/pdf/doc-editor/[id]/route.ts", "src/app/api/doc-editor/[id]/export/route.ts"]) {
    assert.match(code(route), /!\(await hasAnyPermission\(user, "docbuilder\.view", "docbuilder\.manage"\)\) && !\(await canEditLayout\(user, template\.key\)\)/, route);
  }
  // Document Studio offers Edit on those seven to a document_templates.manage holder,
  // and the old template URL lands in the editor that now admits them.
  assert.match(code("src/app/(app)/document-studio/page.tsx"), /const editable = canEditLayout \|\| FORM_EDITOR_KEYS\.has\(key\);/);
  assert.match(code("src/app/(app)/settings/documents/t/[id]/page.tsx"), /requireAnyPermission\("document_templates\.manage", "docbuilder\.manage"\)/);
});

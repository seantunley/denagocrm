import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

/*
 * Found in the review of #925: the invoice, the sales agreement and the old
 * statement page chose their layout and their old form-editor template with no
 * workspace in the query, so with tenant enforcement off one workspace's
 * document could print another's design and bank account. Each now resolves the
 * acting workspace's scope (docbuilder/layoutScope.ts) after its access gate and
 * hands the same scope to every lookup. What those lookups then read is proved
 * against a real database by scripts/test-invoice-workspace.ts; this pins where
 * the scope is taken and that no lookup is left without it.
 */

const read = (path: string) => readFileSync(path, "utf8");

test("the invoice and agreement pages: the scope after the gate, in the switch and on the old page alike", () => {
  for (const key of ["invoice", "agreement"] as const) {
    const page = read(`src/app/(print)/quotes/[id]/${key}/page.tsx`);
    const gate = page.indexOf("await requireQuoteReadAccess(id);");
    const scope = page.indexOf("const scope = await actingLayoutScope();");
    assert.ok(gate > 0 && scope > gate, `${key}: the scope is taken after the access gate`);
    assert.match(page, new RegExp(`builderDocRedirect\\(id, "${key}", search, \\(\\) => publishedBuilderTemplateFor\\("${key}", scope\\)\\)`));
    assert.match(page, new RegExp(`getDocTemplate\\("${key}", tplId, scope\\)`));
    assert.doesNotMatch(page, new RegExp(`publishedBuilderTemplateFor\\("${key}"\\)|getDocTemplate\\("${key}"(, tplId)?\\)`), `${key}: no unscoped lookup left`);
  }
});

test("the published layout, rendered: the layout and its banking text from one scope", () => {
  const print = read("src/lib/quoteBuilderDocPrint.ts");
  assert.match(print, /const scope = await actingLayoutScope\(\);\s*const template = await publishedBuilderTemplateFor\(opts\.key, scope\);/);
  assert.match(print, /getDocTemplate\(opts\.key, undefined, scope\)/);
  assert.doesNotMatch(print, /getDocTemplate\(opts\.key\)/);
});

test("the old statement pages: the invoice template's bank details are the workspace's own, after the gates", () => {
  for (const [kind, gate] of [
    ["contacts", 'await requireAnyPermission("quotes.view_all", "quotes.view_owned");'],
    ["fleets", 'await requireAnyPermission("quotes.view_all", "quotes.view_owned");'],
  ] as const) {
    const page = read(`src/app/(print)/${kind}/[id]/statement/page.tsx`);
    assert.ok(page.indexOf(gate) > 0 && page.indexOf("const scope = await actingLayoutScope();") > page.indexOf(gate), `${kind}: after the gates`);
    assert.match(page, /getDocTemplate\("invoice", undefined, scope\)/);
    assert.doesNotMatch(page, /getDocTemplate\("invoice"\)/);
  }
});

test("the old template store: a scoped default, and a ?tpl= id only inside the scope", () => {
  const store = read("src/lib/docTemplateStore.ts");
  assert.match(store, /export async function getDocTemplate\(key: DocKey, templateId\?: string, scope\?: LayoutScope\)/);
  assert.match(store, /loadDocTemplate\(key, templateId, scope\)/);
  assert.match(store, /if \(rec && rec\.docType === key && \(!scope \|\| layoutRowVisible\(rec\.tenantId, scope\)\)\) \{/);
  assert.match(store, /where: \{ docType: key, isDefault: true, deletedAt: null, \.\.\.\(scope \? layoutScopeWhere\(scope\) : \{\}\) \}/);
  // The builder's default, scoped the same way, and the scope's one resolver.
  const builder = read("src/lib/docbuilder/store.ts");
  assert.match(builder, /where: \{ key, deletedAt: null, \.\.\.\(scope \? layoutScopeWhere\(scope\) : \{\}\) \}/);
  assert.match(builder, /export async function actingLayoutScope\(\): Promise<LayoutScope> \{\s*const tenantId = await actingTenantId\(\);/);
});

test("opening and publishing write in the old text only into this workspace's own invoice or agreement (review of #926)", () => {
  const builder = read("src/lib/docbuilder/store.ts");
  const own = builder.slice(builder.indexOf("export async function ownLayoutWithLegacyText"));
  assert.match(own, /if \(template\.key !== "invoice" && template\.key !== "agreement"\) return template;\s*const scope = await actingLayoutScope\(\);\s*if \(!layoutRowVisible\(template\.tenantId, scope\)\) return null;\s*return withLegacyTextInlined\(template, scope\);/);
  assert.match(builder, /const old = await getDocTemplateText\(template\.key, scope\);/);
  assert.match(read("src/lib/docTemplateStore.ts"), /export async function getDocTemplateText\(key: DocKey, scope\?: LayoutScope\)[^]*?return loadDocTemplate\(key, undefined, scope\);/);
  // The editor's open and Publish are the two places the text is written in; neither calls the unscoped form.
  const editor = read("src/app/doc-editor/[id]/page.tsx");
  assert.match(editor, /getBuilderTemplate\(id\)\.then\(\(t\) => \(t \? ownLayoutWithLegacyText\(t\) : null\)\)/);
  const actions = read("src/app/actions/docbuilder.ts");
  assert.match(actions, /const tpl = await ownLayoutWithLegacyText\(found\);\s*if \(!tpl\) return \{ ok: false \};/);
  for (const source of [editor, actions]) assert.doesNotMatch(source, /withLegacyTextInlined\(/);
});

test("an invoice or agreement layout is its workspace's own: the door, the list, the default, new layouts, seeding (second review of #926)", () => {
  assert.match(read("src/lib/docbuilder/layoutScope.ts"), /export const WORKSPACE_LAYOUT_KEYS: ReadonlySet<string> = new Set\(\["invoice", "agreement"\]\);/);
  const builder = read("src/lib/docbuilder/store.ts");
  // The one door every by-id read and builder action goes through.
  const door = builder.slice(builder.indexOf("export async function getBuilderTemplate"));
  assert.match(door, /if \(WORKSPACE_LAYOUT_KEYS\.has\(record\.key\)\) \{\s*const scope = await actingLayoutScope\(\)\.catch\(\(\) => null\);\s*if \(!scope \|\| !layoutRowVisible\(record\.tenantId, scope\)\) return null;\s*\}\s*return record;/);
  assert.match(builder, /!WORKSPACE_LAYOUT_KEYS\.has\(row\.key\) \|\| \(scope !== null && layoutRowVisible\(row\.tenantId, scope\)\)/);
  // Seeded once per workspace, every query inside it, stamped as its own.
  assert.match(builder, /const workspaceScope = WORKSPACE_LAYOUT_KEYS\.has\(key\) \? await workspaceSeedScope\(\) : undefined;\s*if \(workspaceScope === null\) continue;\s*const owned = workspaceScope \? layoutScopeWhere\(workspaceScope\) : \{\};/);
  assert.match(builder, /where: \{ key, deletedAt: null, \.\.\.owned \}/);
  assert.equal((builder.match(/where: \{ key, createdById: null, deletedAt: null, \.\.\.owned \}/g) ?? []).length, 2);
  assert.match(builder, /\.\.\.\(workspaceScope \? \{ tenantId: workspaceScope\.tenantId \} : \{\}\),/);
  // Set-default unsets only this workspace's; a new or imported layout is stamped as its maker's.
  assert.match(read("src/app/actions/docbuilder.ts"), /const owned = WORKSPACE_LAYOUT_KEYS\.has\(tpl\.key\) \? layoutScopeWhere\(await actingLayoutScope\(\)\) : \{\};\s*await prisma\.\$transaction\(async \(tx\) => \{\s*await tx\.docBuilderTemplate\.updateMany\(\{ where: \{ key: tpl\.key, \.\.\.owned \}/);
  const editorActions = read("src/app/actions/doceditor.ts");
  assert.match(editorActions, /return WORKSPACE_LAYOUT_KEYS\.has\(key\) \? \{ tenantId: \(await actingLayoutScope\(\)\)\.tenantId \} : \{\};/);
  assert.equal((editorActions.match(/\.\.\.\(await newLayoutOwner\(key\)\)/g) ?? []).length, 2, "create and import");
  assert.match(read("src/app/(app)/document-studio/page.tsx"), /if \(WORKSPACE_LAYOUT_KEYS\.has\(row\.key\) && \(scope === null \|\| !layoutRowVisible\(row\.tenantId, scope\)\)\) continue;/);
});

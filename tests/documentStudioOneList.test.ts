import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDocEditorLibraryItem } from "../src/lib/studioClauses";
import SettingsDocumentsPage from "../src/app/(app)/settings/documents/page";
import BuilderPage from "../src/app/(app)/settings/documents/builder/page";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const STUDIO = "src/app/(app)/document-studio/page.tsx";

/** Where a server component's redirect() sends the request. */
async function redirectTarget(render: () => Promise<unknown>): Promise<string> {
  try {
    await render();
  } catch (error) {
    const digest = String((error as { digest?: string }).digest ?? "");
    assert.match(digest, /^NEXT_REDIRECT;/, `expected a redirect, got ${String(error)}`);
    return digest.split(";")[2];
  }
  assert.fail("expected the page to redirect");
}

test("every document card — the quote included — opens its one layout in the document editor", () => {
  const page = src(STUDIO);
  // 2026-10-07: the old form editor (DocTemplateRecord) is no longer offered
  // for any document; design and wording are both edited in the one editor.
  assert.match(page, /const keys = \(Object\.keys\(DOC_DEFS\) as DocKey\[\]\)\.filter\(\(key\) => docKeyAvailable\(key, enabledModules\)\);/);
  assert.match(page, /Edit layout &amp; wording/);
  assert.match(page, /print, PDF and e-signing/);
  assert.doesNotMatch(page, /createDocTemplate|setDefaultDocTemplate|duplicateDocTemplate|deleteDocTemplate|\/settings\/documents\/t\//);
});

test("custom documents can still be created from Document Studio", () => {
  assert.match(src(STUDIO), /action=\{createCustomDocument/);
});

test("/settings/documents forwards templates to Document Studio and the repository to /documents", async () => {
  const at = (params: Record<string, string>) =>
    redirectTarget(() => SettingsDocumentsPage({ searchParams: Promise.resolve(params) }));
  assert.equal(await at({}), "/document-studio");
  assert.equal(await at({ tab: "templates" }), "/document-studio");
  assert.equal(await at({ tab: "studio" }), "/document-studio");
  assert.equal(await at({ tab: "repository" }), "/documents");
  assert.equal(await at({ tab: "repository", q: "invoice", versions: "all" }), "/documents?q=invoice&versions=all");
  assert.equal(await at({ tag: "signed" }), "/documents?tag=signed");
});

test("/settings/documents/builder forwards to Document Studio", async () => {
  assert.equal(await redirectTarget(() => BuilderPage({ searchParams: Promise.resolve({}) })), "/document-studio");
  assert.equal(
    await redirectTarget(() => BuilderPage({ searchParams: Promise.resolve({ q: "Q 12" }) })),
    "/document-studio?q=Q%2012#builder",
  );
});

test("doc-editor library items are not Studio clauses", () => {
  assert.equal(isDocEditorLibraryItem({ contentJson: { kind: "doceditor", blocks: [] } }), true);
  assert.equal(isDocEditorLibraryItem({ contentJson: [{ type: "paragraph", content: [] }] }), false);
  assert.equal(isDocEditorLibraryItem({ contentJson: { kind: "other" } }), false);
  assert.equal(isDocEditorLibraryItem({ contentJson: null }), false);

  // The editor's Library lists Studio clauses only through the filtered helper.
  assert.match(src("src/app/actions/customDocuments.ts"), /listStudioClauses\(\)/);
  assert.doesNotMatch(src(STUDIO), /reusableBlock\.findMany/);
});

test("there is ONE document editor: the Studio free-form editor is gone and its pages redirect", () => {
  for (const gone of ["src/components/StudioEditor.tsx", "src/components/StudioEditorInner.tsx", "src/components/StudioFinalize.tsx", "src/app/actions/studio.ts"]) {
    assert.throws(() => src(gone), /ENOENT/, `${gone} must not exist`);
  }
  for (const page of ["t", "c"]) {
    const code = src(`src/app/(app)/settings/documents/studio/${page}/[id]/page.tsx`);
    assert.match(code, /redirect\("\/document-studio"\)/);
    assert.doesNotMatch(code, /StudioEditor|SaveForm/, `${page}: nothing left to edit with`);
  }
  assert.match(src("src/app/(app)/settings/documents/studio/d/[id]/page.tsx"), /redirect\(`\/doc-editor\/document\/\$\{encodeURIComponent\(id\)\}`\)/);
  assert.match(src("src/app/doc-editor/document/[id]/page.tsx"), /if \(row\.docModelJson == null\) redirect\("\/document-studio"\);/);
  // Nothing in the app links to, or mounts, another editor.
  const studio = src(STUDIO);
  assert.doesNotMatch(studio, /settings\/documents\/studio|StudioEditor|convertStudioTemplate|createReusableBlock/);
});

test("Builder-only users (docbuilder.view/manage) still reach Document Studio, and see only the Builder", () => {
  // The old Document Builder page admitted docbuilder.view/manage. Redirecting it
  // here behind document_templates.manage alone bounced those users to "/".
  const grant = /requireAnyPermission\("document_templates\.manage", "docbuilder\.view", "docbuilder\.manage"\)/;
  assert.match(src("src/app/(app)/document-studio/layout.tsx"), grant);
  const page = src(STUDIO);
  assert.match(page, grant);
  const builderOnly = page.slice(page.indexOf('if (!(await hasPermission(user, "document_templates.manage")))'), page.indexOf("const [canCreateDocument"));
  assert.match(builderOnly, /<BuilderSection user=\{user\} q=\{q\} \/>/);
  assert.doesNotMatch(builderOnly, /createDocTemplate|customDocTemplate|listStudioClauses/);
  assert.match(src("src/components/nav-config.ts"), /can\("document_templates\.manage", "docbuilder\.view", "docbuilder\.manage"\)\) platformLinks\.push\(\{ href: "\/document-studio"/);
});

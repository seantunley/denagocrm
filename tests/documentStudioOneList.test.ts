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

test("the quote card offers only the builder layout, never a DocTemplateRecord form", () => {
  const page = src(STUDIO);
  // Quote DocTemplateRecords are rendered by nothing — they are not even loaded.
  assert.match(page, /\.filter\(\(key\) => key !== "quote"\)/);
  const quoteCard = page.slice(page.indexOf('if (key === "quote")'), page.indexOf("const templates = typedByKey[key]"));
  assert.ok(quoteCard.length > 0, "the quote card branch must exist");
  assert.match(quoteCard, /Edit quote layout/);
  assert.match(quoteCard, /\/doc-editor\/\$\{quoteBuilder\.id\}/);
  assert.match(quoteCard, /print, PDF and e-signing/);
  assert.doesNotMatch(quoteCard, /createDocTemplate|\/settings\/documents\/t\//);
});

test("other operational cards carry the Settings → Documents template actions", () => {
  const page = src(STUDIO);
  for (const action of ["setDefaultDocTemplate", "duplicateDocTemplate", "deleteDocTemplate", "createDocInstance"]) {
    assert.match(page, new RegExp(`action=\\{${action}`), `${action} must be wired`);
  }
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

  // Every Studio clause list goes through the filtered helper, not the raw table.
  for (const rel of [
    STUDIO,
    "src/app/(app)/settings/documents/studio/t/[id]/page.tsx",
    "src/app/(app)/settings/documents/studio/d/[id]/page.tsx",
  ]) {
    const code = src(rel);
    assert.match(code, /listStudioClauses\(\)/, `${rel} must list clauses through listStudioClauses`);
    assert.doesNotMatch(code, /reusableBlock\.findMany/, `${rel} lists ReusableBlock unfiltered`);
  }
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

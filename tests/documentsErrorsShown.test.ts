import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

// Gap audit #22, documents + Document Studio: an empty file, a file over the
// limit, a logo that isn't an image, deleting the default template — each either
// threw ("This page hit an error") or `return`ed silently, which the form read as
// success. Template delete was also a single click with no confirm.

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const docs = src("src/app/actions/documents.ts");

const FORM_ACTIONS = [
  "uploadDocument", "deleteDocument", "createDocTemplate", "updateDocTemplate", "setDefaultDocTemplate",
  "duplicateDocTemplate", "deleteDocTemplate", "uploadTemplateLogo", "renameDocument", "moveDocument",
  "uploadRepoDocument", "replaceDocument",
];

test("every document action returns its refusal", () => {
  for (const name of FORM_ACTIONS) {
    const at = docs.indexOf(`export async function ${name}(`);
    assert.ok(at >= 0, name);
    const body = docs.slice(at, docs.indexOf("\nexport async function ", at + 10) >>> 0 || undefined);
    assert.match(body, /return asActionResult\(async \(\) => \{/, name);
    assert.doesNotMatch(body, /^\s+if \([^)]*\) return;$/m, `${name}: a bare return reads as success`);
    assert.doesNotMatch(body, /findUniqueOrThrow\(/, name);
  }
  assert.doesNotMatch(docs, /\bredirect\(/, "navigate with { redirectTo }");
  assert.doesNotMatch(docs, /withActingStaffScope\(/);
});

test("the default template can't be deleted, and it says why", () => {
  assert.match(docs, /if \(rec\.isDefault\) refuse\("This is the default template — make another one the default first\."\)/);
});

test("deleting a template is confirmed and its reason audited", () => {
  const page = src("src/app/(app)/document-studio/page.tsx");
  assert.match(page, /<ConfirmDelete\s+action=\{deleteDocTemplate\.bind\(null, template\.id\)\}/);
  assert.match(docs, /summary: `Deleted template “\$\{rec\.name\}”\$\{reason \? ` — \$\{reason\}` : ""\}`/);
});

test("studio publish / new clause return refusals and navigate by value", () => {
  const studio = src("src/app/actions/studio.ts");
  for (const name of ["publishStudioTemplate", "createReusableBlock"]) {
    const at = studio.indexOf(`export async function ${name}(`);
    assert.match(studio.slice(at, at + 300), /return asActionResult\(async \(\) => \{/, name);
  }
  assert.match(studio, /return \{ redirectTo: `\/settings\/documents\/studio\/c\/\$\{row\.id\}`/);
  assert.doesNotMatch(studio, /throw new Error\(/);
  assert.doesNotMatch(studio, /findUniqueOrThrow\(/);
});

test("every form posting to these is a SaveForm", () => {
  for (const file of [
    "src/app/(app)/document-studio/page.tsx",
    "src/app/(app)/settings/documents/t/[id]/page.tsx",
    "src/app/(app)/settings/documents/studio/t/[id]/page.tsx",
    "src/components/RepoRow.tsx",
    "src/components/DocumentsPanel.tsx",
  ]) {
    assert.doesNotMatch(src(file), /<form[^>]*\baction=\{/, file);
  }
});

test("the drag-and-drop uploader reports a refused upload instead of 'done'", () => {
  assert.match(src("src/components/documents/useDocumentUploads.ts"), /const result = await uploadDocument\(form\);\s*if \(result\?\.error\) set\(\{ status: "failed", message: result\.error \}\);/);
});

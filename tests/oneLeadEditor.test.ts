import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// Batch 6: a lead had two editors — a full page at /leads/[id]/edit and the
// "Edit details" modal on the lead. One form now: the modal. The old address
// redirects to it so bookmarks keep working.
const root = path.resolve(import.meta.dirname, "..");
const shipped = (rel: string) =>
  readFileSync(path.join(root, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");

test("the old edit page is a redirect, not a second form", () => {
  const code = shipped("src/app/(app)/leads/[id]/edit/page.tsx");
  assert.doesNotMatch(code, /LeadForm/, "the edit page still renders its own LeadForm");
  assert.match(code, /redirect\(`\/leads\/\$\{id\}\?edit=1`\)/);
  assert.match(code, /requireLeadAccess\(id, "leads\.edit"\)/);
});

test("the lead page's editor opens from ?edit=1 and only for leads.edit", () => {
  const code = shipped("src/app/(app)/leads/[id]/page.tsx");
  assert.match(code, /defaultOpen=\{edit === "1"\}/);
  assert.match(code, /hasPermission\(user, "leads\.edit"\)/);
  assert.match(code, /\{canEditLead && <ModalTrigger/);
});

test("nothing links to the old edit page any more", () => {
  for (const file of ["src/app/(app)/leads/list/page.tsx", "src/app/(app)/leads/[id]/page.tsx"]) {
    assert.doesNotMatch(shipped(file), /\/leads\/\$\{[^}]+\}\/edit/, `${file} still links to /edit`);
  }
});

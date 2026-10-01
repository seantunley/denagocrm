import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Gap audit #23: every customer dropdown listed the first 500 contacts, so
// customer 501 onwards could not be chosen — and a record already linked to one
// rendered blank and lost the link on save.

const root = new URL("../", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, root), "utf8").replace(/\r\n/g, "\n");

function tsxFiles(dir: string): string[] {
  const abs = new URL(dir, root);
  return readdirSync(abs).flatMap((name) => {
    const rel = join(dir, name).replace(/\\/g, "/");
    return statSync(new URL(rel, root)).isDirectory() ? tsxFiles(`${rel}/`) : rel.endsWith(".tsx") ? [rel] : [];
  });
}

// The CUSTOMER portal's own form lists only the signed-in customer's linked
// accounts — it must not reach the staff-side search.
const PORTAL_SIDE = new Set(["src/components/PortalExpansionForms.tsx"]);

test("no staff screen picks a customer from a capped <select> any more", () => {
  const offenders = [...tsxFiles("src/app/(app)/"), ...tsxFiles("src/components/")].filter(
    (file) => !PORTAL_SIDE.has(file) && /<select[^>]*name="contactId"/.test(read(file)),
  );
  assert.deepEqual(offenders, [], `use <ContactPicker>: ${offenders.join(", ")}`);
});

test("the picker searches every customer on the server and resolves an unloaded selection", () => {
  const picker = read("src/components/ContactPicker.tsx");
  assert.match(picker, /searchLinkableContacts\(query\)/);
  assert.match(picker, /contactOptionById\(selected\)/);
  // It never drops a link it can't label.
  assert.match(picker, /option \?\? \{ id: selected, label: "Current customer" \}/);
  assert.match(picker, /<input type="hidden" name=\{name\} value=\{selected\} \/>/);
  // Typed-but-unchosen text can't satisfy `required`.
  assert.match(picker, /required=\{required && !selected\}/);
});

test("search: every word must match, scoped to the customers this person may see", () => {
  const leads = read("src/app/actions/leads.ts");
  const search = leads.slice(leads.indexOf("export async function searchLinkableContacts("), leads.indexOf("const CONTACT_OPTION_SELECT"));
  assert.match(search, /const ids = await getAccessibleContactIds\(user\);/);
  assert.match(search, /AND: words\.map\(\(word\) =>/);
  const byId = leads.slice(leads.indexOf("export async function contactOptionById("));
  assert.match(byId, /requireAnyPermission\("contacts\.view_all", "contacts\.view_owned"\)/);
  assert.match(byId, /if \(ids !== null && !ids\.includes\(id\)\) return null;/);
});

test("forms that react to the chosen customer get the option, not a lookup in the preloaded list", () => {
  assert.match(read("src/components/LeadForm.tsx"), /function onContactChange\(id: string, contact: ContactOption \| null\)/);
  assert.match(read("src/components/quotes/QuoteEditorDialog.tsx"), /pickedCustomer\?\.id === draft\.contactId \? pickedCustomer\.label/);
});

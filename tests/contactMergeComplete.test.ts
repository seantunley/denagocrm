import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";

// Gap audit #26: merging contacts left test drives, journeys, marketing
// attribution, survey follow-ups and queued bot messages on the deleted
// duplicate — and it ran on one click. This pins the merge to the SCHEMA, so a
// table added later with a contact column fails here until the merge handles it.

const root = new URL("../", import.meta.url);
const src = (rel: string) => readFileSync(new URL(rel, root), "utf8").replace(/\r\n/g, "\n");
const merge = src("src/app/actions/merge.ts");

/** Every `Model.field` whose field name contains "contactId" (any case), across prisma/*.prisma. */
function contactColumns(): string[] {
  const out = new Set<string>();
  for (const file of readdirSync(new URL("prisma/", root)).filter((f) => f.endsWith(".prisma"))) {
    let model = "";
    for (const line of src(`prisma/${file}`).split("\n")) {
      const m = /^model (\w+) \{/.exec(line);
      if (m) model = m[1];
      const f = /^\s+(\w*[cC]ontactId\w*)\s+String/.exec(line);
      if (model && f) out.add(`${model}.${f[1]}`);
    }
  }
  return [...out].sort();
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
// Handled by name rather than a plain move, each for a stated reason in merge.ts.
const SPECIAL = new Set([
  "PortalPreference.contactId", // PK is contactId — merged conservatively (AND), POPIA
  "PortalAccessGrant.viewerContactId", // partial-unique indexes — mergePortalGrants
  "PortalAccessGrant.grantedContactId",
]);

test("every contact column in the schema is moved (or deliberately handled) by the merge", () => {
  const missing = contactColumns().filter((col) => {
    if (SPECIAL.has(col)) return false;
    const [model, field] = col.split(".");
    return !new RegExp(`move\\(tx\\.${lowerFirst(model)}, "${field}"`).test(merge);
  });
  assert.deepEqual(missing, [], `these stay on the deleted duplicate:\n${missing.join("\n")}`);
});

test("the specially-handled columns really are handled", () => {
  assert.match(merge, /await mergePortalGrants\(tx, keepId, loser\.id\);/);
  assert.match(merge, /tx\.portalPreference\.findUnique\(\{ where: \{ contactId: loser\.id \} \}\)/);
});

test("a merge is confirmed, with who goes where, and audited with what moved and why", () => {
  const page = src("src/app/(app)/duplicates/page.tsx");
  assert.doesNotMatch(page, /<form action=\{mergeContacts/, "one-click merge is back");
  assert.match(page, /<ConfirmDelete\s+action=\{mergeContacts\.bind\(/);
  assert.match(page, /A merge can't be undone\./);
  assert.match(merge, /summary: `Merged \$\{others\.map\(\(o\) => contactName\(o\)\)\.join\(", "\)\} into \$\{contactName\(keep\)\} — moved \$\{movedSummary\} — \$\{reason\}`/);
});

test("duplicates are found by the shared identity rules, not by stripping spaces", () => {
  const page = src("src/app/(app)/duplicates/page.tsx");
  assert.match(page, /const email = emailKey\(contact\.email\);/);
  assert.match(page, /const tail = phoneTail\(contact\.phone\);/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { keptReason } from "../src/lib/contactKeep";

/**
 * Sean, 2026-11-21: a customer with a sale or filed paperwork is never deleted — even after the vehicle changed hands —
 * so the chain of documents stays valid and authentic.
 */
const code = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
const none = { vehicles: 0, owned: 0, won: 0, accepted: 0, documents: 0 };

test("nothing on record: the contact may be deleted", () => {
  assert.equal(keptReason(none), null);
});

test("a sale of any kind, or paperwork, keeps the contact — and says why", () => {
  assert.match(keptReason({ ...none, vehicles: 1, owned: 1 })!, /owns a vehicle/);
  // Sold on: the vehicle is someone else's now, the ownership history still names them.
  assert.match(keptReason({ ...none, owned: 1 })!, /owned a vehicle before/);
  assert.match(keptReason({ ...none, won: 2 })!, /has 2 won deals/);
  assert.match(keptReason({ ...none, accepted: 1 })!, /has an accepted quote/);
  assert.equal(
    keptReason({ ...none, won: 1, documents: 3 }),
    "This customer has a won deal and has 3 filed documents, so they're kept for good and can't be deleted.",
  );
});

test("counted in the contact's own workspace, named in every query; filed, sent-for-signature and generated paperwork all count", () => {
  const keep = code("src/lib/contactKeep.ts");
  assert.match(keep, /basePrisma\.vehicle\.count\(\{ where: \{ tenantId, contactId, deletedAt: null \} \}\)/);
  assert.match(keep, /basePrisma\.vehicleOwnership\.count\(\{ where: \{ tenantId, contactId, reversedAt: null \} \}\)/, "undone transfers don't count");
  assert.match(keep, /basePrisma\.lead\.count\(\{ where: \{ tenantId, contactId, status: "won", deletedAt: null \} \}\)/);
  assert.match(keep, /basePrisma\.quote\.count\(\{ where: \{ tenantId, contactId, status: "accepted", deletedAt: null \} \}\)/);
  assert.match(keep, /basePrisma\.document\.count\(\{ where: \{ tenantId, contactId, deletedAt: null \} \}\)/);
  assert.match(keep, /basePrisma\.signatureRequest\.count\(\{ where: \{ tenantId, contactId \} \}\)/);
  assert.match(keep, /basePrisma\.docInstance\.count\(\{ where: \{ tenantId, contactId \} \}\)/);
  assert.match(keep, /documents: filed \+ signed \+ generated/);
});

test("every way a contact is deleted asks: the Delete action (row held), the contact page's button, the 60-day purge", () => {
  const action = code("src/app/actions/contacts.ts");
  const del = action.slice(action.indexOf("export async function deleteContact"));
  assert.match(del, /SELECT "tenantId" FROM "Contact" WHERE "id" = \$\{id\} FOR UPDATE`;[\s\S]*const kept = await contactKeptBecause\(held\[0\]\.tenantId, id\);\s*if \(kept\) refuse\(kept\);\s*return softDeleteRecord\("contact", id, reason, user\.name, tx\);/);
  const page = code("src/app/(app)/contacts/[id]/page.tsx");
  assert.match(page, /disabled=\{Boolean\(keptBecause\)\}\s*disabledReason=\{keptBecause \?\? undefined\}/);
  const purge = code("src/lib/trash.ts");
  assert.match(purge, /if \(model === "contact"\) \{\s*for \(const r of locked\) if \(await contactKeptBecause\(r\.tenantId, r\.id\)\) kept\.add\(r\.id\);\s*\}\s*const ids = locked\.map\(\(r\) => r\.id\)\.filter\(\(id\) => !kept\.has\(id\)\);/);
  // A transfer TO a contact holds their row, so it can't land between the delete's check and the delete.
  assert.match(code("src/lib/vehicleOwnership.ts"), /SELECT "id" FROM "Contact" WHERE "id" = \$\{newContactId\} AND "tenantId" = \$\{tenantId\} FOR SHARE/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { contactKeptBecause } from "../src/lib/contactKeep";

/**
 * Sean, 2026-11-21: a customer with a sale or filed paperwork is never deleted — even after the vehicle changed hands —
 * so the chain of documents stays valid and authentic.
 */
const code = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

function fakeDb(counts: { vehicle?: number; vehicleOwnership?: number; lead?: number; quote?: number; document?: number; signatureRequest?: number; docInstance?: number }) {
  const seen: Record<string, unknown> = {};
  const model = (name: keyof typeof counts) => ({
    count: async (args: { where: unknown }) => {
      seen[name] = args.where;
      return counts[name] ?? 0;
    },
  });
  return {
    seen,
    db: {
      vehicle: model("vehicle"), vehicleOwnership: model("vehicleOwnership"), lead: model("lead"), quote: model("quote"), document: model("document"),
      signatureRequest: model("signatureRequest"), docInstance: model("docInstance"),
    },
  };
}

test("nothing on record: the contact may be deleted", async () => {
  assert.equal(await contactKeptBecause(fakeDb({}).db, "t1", "c1"), null);
});

test("a sale of any kind, or a filed document, keeps the contact — and says why", async () => {
  assert.match((await contactKeptBecause(fakeDb({ vehicle: 1, vehicleOwnership: 1 }).db, "t1", "c1"))!, /owns a vehicle/);
  // Sold on: the vehicle is someone else's now, the ownership history still names them.
  assert.match((await contactKeptBecause(fakeDb({ vehicleOwnership: 1 }).db, "t1", "c1"))!, /owned a vehicle before/);
  assert.match((await contactKeptBecause(fakeDb({ lead: 2 }).db, "t1", "c1"))!, /has 2 won deals/);
  assert.match((await contactKeptBecause(fakeDb({ quote: 1 }).db, "t1", "c1"))!, /has an accepted quote/);
  assert.equal(
    await contactKeptBecause(fakeDb({ lead: 1, document: 3 }).db, "t1", "c1"),
    "This customer has a won deal and has 3 filed documents, so they're kept for good and can't be deleted.",
  );
  // Sent for signature, or generated for them: paperwork too.
  assert.match((await contactKeptBecause(fakeDb({ signatureRequest: 1 }).db, "t1", "c1"))!, /has a filed document/);
  assert.match((await contactKeptBecause(fakeDb({ docInstance: 1, document: 1 }).db, "t1", "c1"))!, /has 2 filed documents/);
});

test("counted in the contact's own workspace; trashed deals/quotes/documents and undone transfers don't count", async () => {
  const { db, seen } = fakeDb({});
  await contactKeptBecause(db, "t1", "c1");
  assert.deepEqual(seen.vehicleOwnership, { tenantId: "t1", contactId: "c1", reversedAt: null });
  assert.deepEqual(seen.lead, { tenantId: "t1", contactId: "c1", status: "won", deletedAt: null });
  assert.deepEqual(seen.quote, { tenantId: "t1", contactId: "c1", status: "accepted", deletedAt: null });
  assert.deepEqual(seen.document, { tenantId: "t1", contactId: "c1", deletedAt: null });
});

test("every way a contact is deleted asks: the Delete action (row held), the contact page's button, the 60-day purge", () => {
  const action = code("src/app/actions/contacts.ts");
  const del = action.slice(action.indexOf("export async function deleteContact"));
  assert.match(del, /SELECT "tenantId" FROM "Contact" WHERE "id" = \$\{id\} FOR UPDATE`;[\s\S]*const kept = await contactKeptBecause\(tx, held\[0\]\.tenantId, id\);\s*if \(kept\) refuse\(kept\);\s*return softDeleteRecord\("contact", id, reason, user\.name, tx\);/);
  const page = code("src/app/(app)/contacts/[id]/page.tsx");
  assert.match(page, /disabled=\{Boolean\(keptBecause\)\}\s*disabledReason=\{keptBecause \?\? undefined\}/);
  const purge = code("src/lib/trash.ts");
  assert.match(purge, /if \(model === "contact"\) \{\s*for \(const r of locked\) if \(await contactKeptBecause\(tx, r\.tenantId, r\.id\)\) kept\.add\(r\.id\);\s*\}\s*const ids = locked\.map\(\(r\) => r\.id\)\.filter\(\(id\) => !kept\.has\(id\)\);/);
  // A transfer TO a contact holds their row, so it can't land between the delete's check and the delete.
  assert.match(code("src/lib/vehicleOwnership.ts"), /SELECT "id" FROM "Contact" WHERE "id" = \$\{newContactId\} AND "tenantId" = \$\{tenantId\} FOR SHARE/);
});

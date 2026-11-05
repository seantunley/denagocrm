import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CONTACT_CHECKS, DEAL_CHECKS, bySource, cleanShare, failing, snapshotDay, type ContactFacts, type DealFacts } from "../src/lib/dataQualityRules";

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const contact = (over: Partial<ContactFacts> = {}): ContactFacts => ({ id: "c", email: "lee@example.com", phone: "082 555 1234", whatsapp: null, ownerId: "u1", source: "website", ...over });
const deal = (over: Partial<DealFacts> = {}): DealFacts => ({
  id: "d", status: "open", contactId: "c", valueCents: 250_000_00, assignedToId: "u1", email: null, phone: null, contact: { email: "lee@example.com", phone: "082 555 1234" }, ...over,
});
const keys = <T,>(row: T, checks: { key: string; problem: (r: T) => boolean }[]) => checks.filter((c) => c.problem(row)).map((c) => c.key);

test("a complete customer has no problem; each gap is named", () => {
  assert.deepEqual(keys(contact(), CONTACT_CHECKS), []);
  assert.deepEqual(keys(contact({ email: null, phone: null }), CONTACT_CHECKS), ["unreachable"]);
  assert.deepEqual(keys(contact({ email: null, phone: null, whatsapp: "082" }), CONTACT_CHECKS), [], "WhatsApp alone reaches them");
  assert.deepEqual(keys(contact({ ownerId: null, source: " " }), CONTACT_CHECKS), ["no_owner", "no_source"]);
  assert.deepEqual(keys(contact({ email: "lee at example" }), CONTACT_CHECKS), ["bad_email"]);
  assert.deepEqual(keys(contact({ phone: "1234" }), CONTACT_CHECKS), ["bad_phone"]);
  assert.deepEqual(keys(contact({ phone: "+27 (82) 555-1234" }), CONTACT_CHECKS), [], "formatting is fine");
});

test("deals: missing pieces on OPEN deals, and a deal that disagrees with its customer", () => {
  assert.deepEqual(keys(deal(), DEAL_CHECKS), []);
  assert.deepEqual(keys(deal({ contactId: null, contact: null, valueCents: 0, assignedToId: null }), DEAL_CHECKS), ["no_customer", "no_value", "no_owner"]);
  assert.deepEqual(keys(deal({ status: "won", valueCents: 0, assignedToId: null }), DEAL_CHECKS), [], "closed deals aren't nagged about");
  assert.deepEqual(keys(deal({ email: "LEE@example.com " }), DEAL_CHECKS), [], "the same email, written differently");
  assert.deepEqual(keys(deal({ email: "old@example.com" }), DEAL_CHECKS), ["conflict"]);
  assert.deepEqual(keys(deal({ phone: "+27 82 555 1234" }), DEAL_CHECKS), [], "the same number, with +27");
  assert.deepEqual(keys(deal({ phone: "083 999 0000" }), DEAL_CHECKS), ["conflict"]);
});

test("scores, failing lists and sources", () => {
  const rows = [contact({ id: "a" }), contact({ id: "b", ownerId: null }), contact({ id: "c", source: null }), contact({ id: "d" })];
  assert.equal(cleanShare(rows, CONTACT_CHECKS), 50);
  assert.equal(cleanShare([], CONTACT_CHECKS), 100);
  assert.deepEqual(failing(rows, CONTACT_CHECKS).no_owner.map((r) => r.id), ["b"]);
  assert.deepEqual(bySource(rows), [{ source: "website", count: 3 }, { source: "Unknown", count: 1 }]);
  assert.equal(snapshotDay(new Date("2026-11-05T22:30:00Z")), "2026-11-06", "South African day");
});

test("only what the person may open, and the trend only for someone who sees everything", () => {
  const lib = read("src/lib/dataQuality.ts");
  assert.match(lib, /getAccessibleContactIds\(user\), getAccessibleLeadIds\(user\)/);
  assert.match(lib, /const wholeWorkspace = contactIds === null && leadIds === null;\s*let trend[^\n]*\n\s*if \(wholeWorkspace\)/);
  assert.match(lib, /dataQualitySnapshot\s*\.create\(\{ data: \{ tenantId, day,/);
  assert.match(read("src/lib/routeAccess.ts"), /\{ prefix: "\/data-quality", anyOf: \["contacts\.view_all", "contacts\.view_owned"\] \}/);
  assert.match(read("src/app/(app)/data-quality/page.tsx"), /const user = await requireRoute\("\/data-quality"\);/);
});

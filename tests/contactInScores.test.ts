import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { contactActivityWhere, contactCommunicationWhere, latestContactAt } from "../src/lib/customerContact";

const code = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/*
 * Customer health and the lead score both ask "when did we last speak to this
 * customer?". An internal note, a ticked-off to-do or blocked-out time is not
 * an answer — it made a customer someone had merely annotated look recently
 * contacted (health stayed green; the lead dropped out of the Today queue).
 */

test("a newer internal note or to-do never replaces an older real contact", () => {
  const day = (n: number) => new Date(Date.UTC(2026, 9, n));
  assert.deepEqual(latestContactAt([{ type: "note", occurredAt: day(10) }, { type: "call", occurredAt: day(2) }], []), day(2));
  assert.deepEqual(latestContactAt([], [{ type: "todo", doneAt: day(12) }, { type: "meeting", doneAt: day(4) }]), day(4));
  assert.deepEqual(latestContactAt([], [{ type: "meeting", doneAt: day(11), availabilityBlock: true }]), null);
  assert.deepEqual(contactCommunicationWhere, { type: { notIn: ["note"] } });
  assert.deepEqual(contactActivityWhere, { status: "done", availabilityBlock: false, type: { notIn: ["todo"] } });
});

test("customer health reads last contact through the rule — both queries", () => {
  const health = code("src/lib/healthData.ts");
  assert.equal((health.match(/communications: \{ where: contactCommunicationWhere,/g) ?? []).length, 2, "the list and the single-customer view");
  assert.doesNotMatch(health, /communications: \{ select: \{ occurredAt: true \}/, "no unfiltered last-communication left");
});

test("the lead score reads last contact through the same rule — messages AND activities", () => {
  const score = code("src/lib/leadScoreLoader.ts");
  assert.match(score, /where: \{ leadId, \.\.\.contactCommunicationWhere \}/);
  assert.match(score, /where: \{ leadId, \.\.\.contactActivityWhere \}/, "a ticked-off to-do no longer resets last contact");
  assert.doesNotMatch(score, /where: \{ leadId, status: "done" \}/);
});

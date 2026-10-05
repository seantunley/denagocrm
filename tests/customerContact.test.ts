import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  INTERNAL_COMMUNICATION_TYPES,
  NON_CONTACT_ACTIVITY_TYPES,
  contactActivityWhere,
  contactCommunicationWhere,
  isCustomerContact,
} from "../src/lib/customerContact";

const code = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

test("an internal note, a to-do or blocked time is not contact with the customer", () => {
  assert.ok(INTERNAL_COMMUNICATION_TYPES.includes("note"));
  assert.ok(NON_CONTACT_ACTIVITY_TYPES.includes("todo"));
  assert.equal(isCustomerContact({ type: "note" }, "communication"), false);
  for (const type of ["call", "email", "whatsapp", "meeting", "telegram", "x"]) {
    assert.equal(isCustomerContact({ type }, "communication"), true, type);
  }
  assert.equal(isCustomerContact({ type: "todo" }, "activity"), false);
  assert.equal(isCustomerContact({ type: "call" }, "activity"), true);
  assert.deepEqual(contactCommunicationWhere, { type: { notIn: ["note"] } });
  assert.deepEqual(contactActivityWhere, { status: "done", availabilityBlock: false, type: { notIn: ["todo"] } });
});

test("'gone quiet' and 'oldest contact' only count real contact", () => {
  const lib = code("src/lib/crmAssistant.ts");
  const find = lib.slice(lib.indexOf("async function findLeads("), lib.indexOf("const withTouch"));
  assert.match(find, /communications: \{ where: contactCommunicationWhere,/, "a note doesn't reset the clock");
  assert.match(find, /activities: \{ where: contactActivityWhere,/, "a done to-do or blocked time doesn't either");
  assert.match(code("src/lib/crmAssistantPlan.ts"), /internal notes and to-dos do not count/, "the plan step is told what contact means");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  INTERNAL_COMMUNICATION_TYPES,
  NON_CONTACT_ACTIVITY_TYPES,
  contactActivityWhere,
  contactCommunicationWhere,
  isCustomerContact,
  latestContactAt,
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

test("a NEWER internal note never replaces an OLDER real contact as last contact", () => {
  const day = (n: number) => new Date(Date.UTC(2026, 9, n));
  // Called on the 2nd; a staff note was added on the 10th.
  assert.deepEqual(
    latestContactAt(
      [
        { type: "note", occurredAt: day(10) },
        { type: "call", occurredAt: day(2) },
      ],
      [],
    ),
    day(2),
  );
  // A to-do ticked off and blocked-out time later still don't count; a meeting does.
  assert.deepEqual(
    latestContactAt(
      [{ type: "whatsapp", occurredAt: day(3) }],
      [
        { type: "todo", doneAt: day(12) },
        { type: "meeting", doneAt: day(11), availabilityBlock: true },
        { type: "meeting", doneAt: day(5) },
      ],
    ),
    day(5),
  );
  // Only notes → never contacted.
  assert.equal(latestContactAt([{ type: "note", occurredAt: day(9) }], [{ type: "todo", doneAt: day(9) }]), null);
});

test("'gone quiet' and 'oldest contact' only count real contact", () => {
  const lib = code("src/lib/crmAssistant.ts");
  const find = lib.slice(lib.indexOf("async function findLeads("), lib.indexOf("const withTouch"));
  assert.match(find, /communications: \{ where: contactCommunicationWhere,/, "a note doesn't reset the clock");
  assert.match(find, /activities: \{\s*where: contactActivityWhere,/, "a done to-do or blocked time doesn't either");
  assert.match(lib, /lastContact: latestContactAt\(lead\.communications, lead\.activities\)/, "and the same rule is applied to the rows");
  assert.match(code("src/lib/crmAssistantPlan.ts"), /internal notes and to-dos do not count/, "the plan step is told what contact means");
});

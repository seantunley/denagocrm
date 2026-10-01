import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

/**
 * Creating a customer from a lead existed only on the leads LIST, so on the lead
 * itself staff could only link someone who already existed (2026-09-30, Leon van
 * Rooyen). The lead page now offers it, and the new customer reaches the lead's
 * draft quotes too.
 */
const page = readFileSync("src/app/(app)/leads/[id]/page.tsx", "utf8");
const actions = readFileSync("src/app/actions/leads.ts", "utf8");

test("a lead with no customer offers 'Create customer from this lead' on its own page", () => {
  assert.match(page, /\{!lead\.contact && \(/);
  assert.match(page, /<AddToContactsButton leadId=\{lead\.id\} label="Create customer from this lead" \/>/);
});

test("creating the customer also fills it in on the lead's customerless draft quotes", () => {
  // Shared with Mark won, so both link the customer the same way.
  const convert = actions.slice(actions.indexOf("export async function convertLeadToContact"));
  assert.match(convert.slice(0, convert.indexOf("\nexport ", 1)), /linkOrCreateLeadContact\(lead, user, null\)/);
  const helper = actions.slice(actions.indexOf("async function linkOrCreateLeadContact"));
  assert.match(helper, /quote\.updateMany\(\{\s*where: \{ leadId: lead\.id, contactId: null, status: "draft", deletedAt: null \}/);
});

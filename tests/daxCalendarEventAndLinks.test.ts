import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { CALENDAR_ITEM_RULE, invalidActionReasons, parseActionList, settledAnswer } from "../src/lib/assistantActions";
import { planWhatsAppReply, splitForWhatsApp, withoutCrmLinks } from "../src/lib/assistantWhatsAppRules";
import { REPLY_MARKER, splitReply } from "../src/lib/assistantReply";

/**
 * Sean, 2026-11-13: "book a calendar item on the 22nd of November for Donovan and myself to attend that show from
 * 7:00 until 4:00". DAX checked both calendars, proposed a 540-minute meeting, the 8-hour cap refused it without a
 * word, and every "try again" wrote the same meeting — a loop.
 */
const show = { type: "meeting", when: "2026-11-22T07:00", minutes: 540, with: ["Donovan"], summary: "Tannery Motor Show — Wellington" };

test("a full-day event with a colleague is a meeting DAX can propose", () => {
  assert.equal(parseActionList([show]).length, 1, "07:00 to 16:00 is a meeting, not refused");
  assert.equal(parseActionList([{ ...show, minutes: 720 }]).length, 1, "up to 12 hours");
  assert.equal(parseActionList([{ ...show, minutes: 721 }]).length, 0);
  assert.match(CALENDAR_ITEM_RULE, /"minutes":540,"with":\["Donovan"\]/, "the prompt shows the shape for an event colleagues attend");
  assert.match(CALENDAR_ITEM_RULE, /at most 12 hours/);
});

test("a refused task says WHY — so 'try again' can't write the same one again", () => {
  assert.deepEqual(invalidActionReasons([{ ...show, minutes: 900 }]), ["The meeting was too long — the most is 12 hours."]);
  assert.deepEqual(invalidActionReasons([{ ...show, colour: "red" }]), ["The meeting had details it doesn't take (colour)."]);
  assert.deepEqual(invalidActionReasons([{ type: "meeting", when: "Sunday" }]), ["The meeting had a problem with its when."]);
  assert.deepEqual(invalidActionReasons([{ type: "teleport" }]), ["The teleport isn't something I can set up."]);
  assert.deepEqual(invalidActionReasons([show]), [], "a valid one has no reason");

  // Through the reply parser, into the answer the person (and DAX next turn) reads.
  const parsed = splitReply(`Booked.\n${REPLY_MARKER}\n${JSON.stringify({ actions: [{ ...show, minutes: 900 }] })}`);
  assert.deepEqual(parsed.invalid, ["The meeting was too long — the most is 12 hours."]);
  const answer = settledAnswer("I've set it up for you to confirm.", [], parsed.invalid, 0);
  assert.match(answer ?? "", /too long — the most is 12 hours/);
  assert.doesNotMatch(answer ?? "", /couldn't be set up from what I wrote/);

  const assistant = readFileSync(new URL("../src/lib/crmAssistant.ts", import.meta.url), "utf8");
  assert.match(assistant, /const problems: string\[\] = proposes \? \[\.\.\.reply\.invalid\] : \[\];/);
});

test("WhatsApp gets the words, not the CRM link", () => {
  const myDay = "My day — One to-do is due today: [delivery of a Denago EV Rover XL to 1 Oak Consulting](/leads/cmvj1aodg0004l708hgkqlmex).";
  assert.equal(withoutCrmLinks(myDay), "My day — One to-do is due today: delivery of a Denago EV Rover XL to 1 Oak Consulting.");
  assert.equal(withoutCrmLinks("Source: [Tannery Cars](https://tannerycars.co.za/events/)"), "Source: Tannery Cars (https://tannerycars.co.za/events/)", "a web source keeps its tappable address");
  assert.doesNotMatch(splitForWhatsApp(myDay).join("\n"), /\/leads\//, "scheduled updates and briefs");
  assert.doesNotMatch(planWhatsAppReply(myDay).texts.join("\n"), /\/leads\//, "replies");
  assert.doesNotMatch(planWhatsAppReply(myDay, ["Yes", "No"]).buttons?.body ?? "", /\/leads\//, "a short reply riding on its buttons");
});

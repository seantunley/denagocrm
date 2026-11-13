import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { CALENDAR_ITEM_RULE, invalidActionReasons, parseActionList, settledAnswer } from "../src/lib/assistantActions";
import { planWhatsAppReply, splitForWhatsApp, withoutCrmLinks } from "../src/lib/assistantWhatsAppRules";
import { REPLY_MARKER, splitReply } from "../src/lib/assistantReply";
import { parseSteps } from "../src/lib/crmAssistantPlan";

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

test("words only shown on a card are shortened, never a reason to refuse the task", () => {
  const long = "x".repeat(400);
  const [meeting] = parseActionList([{ ...show, summary: long, reason: long }]);
  assert.ok(meeting, "a long title or why no longer sinks the booking");
  assert.equal((meeting as { summary?: string }).summary?.length, 120);
  assert.equal((meeting as { reason?: string }).reason?.length, 160);
  assert.equal(parseActionList([{ ...show, with: Array.from({ length: 12 }, (_, i) => `Person ${i}`) }]).length, 1, "a team meeting of 12");
  assert.match(invalidActionReasons([{ type: "note", leadId: "cmwatj10v0004ku08qygiessp", text: "y".repeat(2500) }])[0], /note's text was too long — the most is 2000 characters/);
});

test("EVERY task that becomes no card says why — no silent drop left in resolveActions", () => {
  const assistant = readFileSync(new URL("../src/lib/crmAssistant.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = assistant.indexOf("export async function resolveActions(");
  const body = assistant.slice(start, assistant.indexOf("\n}\n", start));
  const silent = body.split("\n").filter((line) => /if \(.*\) continue;/.test(line) && !/problems\.push/.test(line));
  // The two left are not refusals: check-backs are saved elsewhere, and an unchanged customer field is just skipped.
  assert.deepEqual(silent.map((l) => l.trim()), [
    'if (p.type === "check_back" || p.type === "drop_waiting") continue;',
    'if (!now || (c[field] ?? "").trim() === now) continue;',
  ]);
  assert.match(body, /I can't find a colleague called/, "a colleague it can't match is said, not left off the meeting");
  assert.match(body, /has already passed — say the day again/);
});

test("a lookup asking for a little too much is adjusted, not thrown away", () => {
  const one = (s: string) => parseSteps(s)?.[0] as { tool: string; args: Record<string, unknown> } | undefined;
  // The shapes that came back null before (2026-11-13 probe).
  assert.deepEqual(one('{"tool":"find_activities","args":{"from":"2026-11-12","to":"2026-11-12","type":"note"}}')?.args, { when: "upcoming", type: "note", from: "2026-11-12", to: "2026-11-12" }, "dates without when");
  assert.equal(one('{"tool":"find_activities","args":{"when":"past","from":"2026-11-12","limit":200}}')?.args.limit, 25, "too many results → the most");
  assert.equal(one('{"tool":"catch_up","args":{"since":"2026-11-12T00:00"}}')?.args.since, "2026-11-12", "a date with a time → the date");
  assert.equal(one('{"tool":"schedule","args":{"person":"Sean","from":"2026-12-01","days":31}}')?.args.days, 31, "a month ahead");
  assert.equal(one('{"tool":"schedule","args":{"days":90}}')?.args.days, 31);
  assert.equal(one('{"tool":"find_leads","args":{"limit":100}}')?.args.limit, 25);
});

test("WhatsApp gets the words, not the CRM link", () => {
  const myDay = "My day — One to-do is due today: [delivery of a Denago EV Rover XL to 1 Oak Consulting](/leads/cmvj1aodg0004l708hgkqlmex).";
  assert.equal(withoutCrmLinks(myDay), "My day — One to-do is due today: delivery of a Denago EV Rover XL to 1 Oak Consulting.");
  assert.equal(withoutCrmLinks("Source: [Tannery Cars](https://tannerycars.co.za/events/)"), "Source: Tannery Cars (https://tannerycars.co.za/events/)", "a web source keeps its tappable address");
  assert.doesNotMatch(splitForWhatsApp(myDay).join("\n"), /\/leads\//, "scheduled updates and briefs");
  assert.doesNotMatch(planWhatsAppReply(myDay).texts.join("\n"), /\/leads\//, "replies");
  assert.doesNotMatch(planWhatsAppReply(myDay, ["Yes", "No"]).buttons?.body ?? "", /\/leads\//, "a short reply riding on its buttons");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ActionCard } from "../src/lib/assistantActions";
import {
  FAMILIES,
  cardRecords,
  confirmedKind,
  describeTally,
  familyOf,
  forwardMoves,
  kindFromSummary,
  mayCount,
  percent,
  RECORDLESS_KINDS,
  proposedCards,
  readProposed,
  summarizeOutcomes,
  type Confirmation,
  type Happening,
  type Outcome,
  type Visible,
} from "../src/lib/assistantOutcomeRules";

/**
 * Outcome tracking, step 1 (Sean, 2026-11-02): Settings → Assistant shows how DAX's suggestions worked out — what it
 * offered, what was confirmed, and what happened after. Measure and show only. The counting is pure and tested here;
 * the real-database half (workspaces, a restricted owner, the real Confirm) is scripts/test-assistant-outcomes.ts.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");

const DAY = 86_400_000;
const T0 = new Date("2026-10-01T09:00:00Z");
const at = (days: number) => new Date(T0.getTime() + days * DAY);
const NOW = at(30);
const everything = null;
const nothing: Record<Outcome, Happening[]> = { reply: [], quote: [], progress: [] };
const confirm = (kind: string | null, on: { leadId?: string; contactId?: string }, userId = "u1", when = T0): Confirmation => ({
  kind, userId, at: when, leadId: on.leadId ?? null, contactId: on.contactId ?? null,
});
const row = (result: ReturnType<typeof summarizeOutcomes>, key: string) => result.families.find((f) => f.key === key)!;

test("each kind of card counts in one family; anything new or unknown is Other, with no outcome", () => {
  const expect: Record<string, string> = {
    follow_up: "follow_ups", reschedule: "follow_ups",
    draft_message: "messages",
    note: "notes", customer_note: "notes",
    stage: "stage", assign: "stage", nurture: "stage",
    quote: "quotes", quote_build: "quotes", quote_add: "quotes", quote_change: "quotes", quote_pdf: "quotes",
    meeting: "meetings", test_drive: "meetings",
    create_customer: "other", create_lead: "other", update_customer: "other", attach_file: "other", record_payment: "other",
    job_card: "other", block_time: "other", cancel_activity: "other", lost: "other", schedule: "other", watch: "other", plan: "other",
    schedule_delivery: "other", delivery: "other",
  };
  for (const [kind, family] of Object.entries(expect)) assert.equal(familyOf(kind).key, family, kind);
  assert.equal(familyOf(null).key, "other");
  assert.equal(familyOf("other").outcome, null);
  const listed = FAMILIES.flatMap((f) => f.kinds);
  assert.equal(new Set(listed).size, listed.length, "no kind is in two families");
  assert.deepEqual(
    FAMILIES.map((f) => [f.label, f.outcome]),
    [
      ["Follow-ups & reminders", "reply"], ["Messages drafted", "reply"], ["Notes", "reply"], ["Stage & assignment", "progress"],
      ["Quotes", "quote"], ["Meetings & test drives", "reply"], ["Other", null],
    ],
  );
});

test("a Reactivate from Nurture (#943) is read back and counted with stage decisions, judged by progress", () => {
  assert.equal(kindFromSummary("Confirmed the assistant's proposal: bring the deal back from Nurture"), "reactivate");
  assert.equal(familyOf("reactivate").key, "stage");
  assert.equal(familyOf("reactivate").outcome, "progress");
  assert.equal(familyOf("nurture").key, "stage", "parking and bringing back sit together");
});

test("an older Confirm, recorded before the kind was, is read back from its summary", () => {
  const said = (what: string) => kindFromSummary(`Confirmed the assistant's proposal: ${what}`);
  const cases: [string, string][] = [
    ["schedule a call", "follow_up"], ["schedule a email", "follow_up"], ["add a note", "note"], ["add a note (pinned)", "note"],
    ["add a new customer", "create_customer"], ["open a lead", "create_lead"], ["file a document", "attach_file"],
    ["record the deposit", "record_payment"], ["record a payment", "record_payment"], ["update the customer's details", "update_customer"],
    ["give the lead to Sean Tunley", "assign"], ["move the lead to another stage", "stage"], ["book a meeting", "meeting"],
    ["book a test drive", "test_drive"], ["open job card #12", "job_card"], ["block time on their own calendar", "block_time"],
    ["reschedule an activity", "reschedule"], ["cancel an activity", "cancel_activity"], ["mark the deal lost", "lost"],
    ["start a quote", "quote"], ["create draft quote Q-1029", "quote_build"], ["send me the PDF of quote Q-1029", "quote_pdf"],
    ["change draft quote Q-1029", "quote_change"], ["add to draft quote Q-1029", "quote_add"],
    ["park the deal in Nurture", "nurture"], ["book the delivery", "schedule_delivery"], ["move the delivery", "schedule_delivery"],
  ];
  for (const [what, kind] of cases) assert.equal(said(what), kind, what);
  assert.equal(said("do something new"), null, "an unknown wording is Other");
  assert.equal(kindFromSummary("Sent a WhatsApp the assistant drafted, after reviewing it"), null);
});

/**
 * The first argument of a call starting at `from` (just after its "("): up to the comma at depth 0, stepping over
 * strings and templates whole — so `card.from ? "move the delivery" : "book the delivery"` is one argument.
 */
function firstArgument(source: string, from: number): string {
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"' || ch === "`") i = source.indexOf(ch, i + 1);
    else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) {
      if (depth === 0) return source.slice(from, i);
      depth--;
    } else if (ch === "," && depth === 0) return source.slice(from, i);
  }
  throw new Error("unterminated call");
}
/** Every wording an argument can produce: each string literal in it, with a template's ${…} as a placeholder. */
function wordingsIn(argument: string): string[] {
  const templates = [...argument.matchAll(/`([^`]*)`/g)].map((m) => m[1].replace(/\$\{[^}]*\}/g, " X"));
  const plain = [...argument.replace(/`[^`]*`/g, "").matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  return [...templates, ...plain];
}

test("every wording runAssistantAction writes today — derived from every confirmed(…) call — is one the summary reading knows", () => {
  const source = read("src/app/actions/assistant.ts");
  const calls = [...source.matchAll(/\bconfirmed(?:On)?\(/g)].map((m) => firstArgument(source, m.index! + m[0].length));
  assert.ok(calls.length >= 15, `found ${calls.length} calls`);
  assert.ok(calls.some((a) => a.includes("park the deal in Nurture")) && calls.some((a) => a.includes("move the delivery") && a.includes("book the delivery")));
  for (const argument of calls) {
    const wordings = wordingsIn(argument);
    // A wording built from a variable alone could never be read back from an older entry — say so here, not later.
    assert.ok(wordings.length > 0, `a confirmed(…) call with no literal wording: ${argument}`);
    for (const what of wordings) assert.notEqual(kindFromSummary(`Confirmed the assistant's proposal: ${what}`), null, what);
  }
  // The direct entries; not the two helpers' own `${what}` (their wordings are the calls above).
  const direct = [...source.matchAll(/summary: [`"]Confirmed the assistant's proposal: ([^`"]+)[`"]/g)].filter((m) => !m[1].startsWith("${"));
  assert.ok(direct.length >= 10, `found ${direct.length}`);
  for (const m of direct) {
    const what = m[1].replace(/\$\{[^}]*\}/g, " X");
    assert.notEqual(kindFromSummary(`Confirmed the assistant's proposal: ${what}`), null, what);
  }
});

test("a Confirm's kind: the stamped one first, else the summary; a Send, a schedule and a watch by their event", () => {
  const event = (eventType: string, metadata: unknown, summary = "Confirmed the assistant's proposal: add a note") => ({ eventType, metadata, summary });
  assert.equal(confirmedKind(event("assistant.action_confirmed", { kind: "customer_note" })), "customer_note");
  assert.equal(confirmedKind(event("assistant.action_confirmed", null)), "note");
  assert.equal(confirmedKind(event("assistant.action_confirmed", { kind: 7 })), "note", "a stamp that is not a kind is ignored");
  assert.equal(confirmedKind(event("assistant.action_confirmed", { kind: "delivery" })), "delivery", "a new kind is kept (it counts under Other)");
  assert.equal(confirmedKind(event("assistant.draft_sent", null, "Sent a WhatsApp the assistant drafted, after reviewing it")), "draft_message");
  assert.equal(confirmedKind(event("assistant.schedule_created", null, "Scheduled a question for the assistant (daily)")), "schedule");
  assert.equal(confirmedKind(event("assistant.watch_created", null, "Set up an assistant watch (quote opened)")), "watch");
});

test("what is kept of an offered card: its kind and every record it is on, by id — never a name or its text", () => {
  const cards = [
    { id: "a0-l1", kind: "note", leadId: "l1", leadLabel: "Clive Jammine", title: "Add a note", text: "Wants black" },
    { id: "a1-c1", kind: "customer_note", contactId: "c1", leadId: null, leadLabel: "Anna", title: "Note on Anna", text: "x" },
    { id: "a2-own", kind: "follow_up", leadId: null, contactId: null, leadLabel: "Your calendar", title: "Call back", when: "2026-11-03T09:00", activity: "call" },
    { id: "a3-schedule", kind: "schedule", title: "Every Monday", question: "How are my deals?", cadence: "weekly", timeOfDay: "07:30" },
    // The records that live off the card's top level, or are not a deal or customer.
    { id: "a4-q", kind: "quote_pdf", leadId: null, leadLabel: "Anna", title: "PDF", quoteId: "q1", quoteNumber: 1 },
    { id: "a5-f", kind: "attach_file", leadId: null, leadLabel: "Rover", title: "File", uploadId: "u", fileName: "x.pdf", target: { vehicleId: "v1" }, label: null, detail: "", confirmKey: "k" },
    { id: "a6-w", kind: "watch", title: "Tell me", watch: { kind: "quote_opened", quoteId: "q2" } },
    { id: "a7-l", kind: "create_lead", leadId: null, leadLabel: "Ben", title: "Lead", lead: { contactId: "c2", name: "Ben" }, detail: "", confirmKey: "k" },
    { id: "a8-d", kind: "schedule_delivery", leadId: "l3", leadLabel: "Cara", title: "Deliver", quoteId: "q3", quoteNumber: 3, date: "2026-11-10", from: null, detail: "" },
    { id: "a9-p", kind: "plan", leadId: null, leadLabel: "2 steps", title: "Plan", plan: { taskId: "t", steps: [] } },
  ] as unknown as ActionCard[];
  assert.deepEqual(proposedCards(cards), [
    { kind: "note", leadId: "l1" },
    { kind: "customer_note", contactId: "c1" },
    { kind: "follow_up" },
    { kind: "schedule" },
    { kind: "quote_pdf", quoteId: "q1" },
    { kind: "attach_file", vehicleId: "v1" },
    { kind: "watch", quoteId: "q2" },
    { kind: "create_lead", contactId: "c2" },
    { kind: "schedule_delivery", leadId: "l3", quoteId: "q3" },
    { kind: "plan" },
  ]);
  assert.deepEqual(readProposed([{ kind: "note", leadId: "l1" }, null, 3, { leadId: "x" }, "note"]), [{ kind: "note", leadId: "l1" }]);
  assert.deepEqual(readProposed(null), []);
  assert.deepEqual(readProposed({ kind: "note" }), []);
});

test("a deal moved forward: a stage change to a later stage, read from moveLead's audit entry", () => {
  const order = new Map([["s1", 1], ["s2", 2], ["s3", 3]]);
  const move = (from: unknown, to: unknown, entityId: string | null = "l1") => ({ entityId, beforeJson: { stageId: from, position: 0 }, afterJson: { stageId: to, position: 1 }, createdAt: at(2) });
  assert.deepEqual(forwardMoves([move("s1", "s3")], order), [{ at: at(2), leadId: "l1", contactId: null }]);
  assert.deepEqual(forwardMoves([move("s3", "s1"), move("s2", "s2"), move("s1", "gone"), move("s1", "s2", null)], order), []);
  assert.deepEqual(forwardMoves([{ entityId: "l1", beforeJson: null, afterJson: "s2", createdAt: at(1) }], order), []);
});

test("what happened after: within the window, after the Confirm, on that deal or its customer", () => {
  const result = summarizeOutcomes({
    now: NOW,
    staffIds: new Set(["u1", "u2"]),
    visible: everything,
    proposals: [
      { kind: "note", leadId: "l1", userId: "u1" },
      { kind: "note", leadId: "l2", userId: "u1" },
      { kind: "note", leadId: "l9", userId: "u1" },
      { kind: "follow_up", userId: "u1" },
      { kind: "follow_up", leadId: "l3", userId: "u2" },
      { kind: "follow_up", leadId: "l3b", userId: "u2" },
      { kind: "customer_note", contactId: "c4", userId: "u2" },
      { kind: "stage", leadId: "l5", userId: "u1" },
      { kind: "assign", leadId: "l6", userId: "u1" },
      { kind: "quote_build", leadId: "l7", userId: "u2" },
      { kind: "quote_pdf", contactId: "c8", userId: "u2" },
      { kind: "schedule", userId: "u1" },
    ],
    confirmations: [
      confirm("note", { leadId: "l1", contactId: "c1" }), // the customer wrote a day later: replied
      confirm("note", { leadId: "l2", contactId: "c2" }), // four days later: not within 3
      confirm("note", { leadId: "l9", contactId: "c9" }, "u1", at(29)), // yesterday: too recent to tell
      confirm("follow_up", {}), // their own calendar: counted, nothing to judge
      confirm("follow_up", { leadId: "l3", contactId: "c3" }, "u2"), // the message came BEFORE the Confirm
      confirm("customer_note", { contactId: "c4" }, "u2"), // a reply on one of the customer's deals counts
      confirm("stage", { leadId: "l5", contactId: "c5" }),
      confirm("assign", { leadId: "l6", contactId: "c6" }),
      confirm("quote_build", { leadId: "l7", contactId: "c7" }, "u2"),
      confirm("quote_pdf", { contactId: "c8" }, "u2"),
      confirm(null, { leadId: "l10" }, "gone"), // someone no longer in the team, an unreadable old entry
    ],
    happened: {
      reply: [
        { at: at(1), leadId: null, contactId: "c1" },
        { at: at(4), leadId: "l2", contactId: "c2" },
        { at: at(-0.01), leadId: "l3", contactId: "c3" },
        { at: at(2), leadId: "l4x", contactId: "c4" },
        { at: at(1), leadId: null, contactId: "someone-else" },
      ],
      quote: [{ at: at(10), leadId: "l7", contactId: "c7" }, { at: at(3), leadId: "l8b", contactId: "c8" }],
      progress: [{ at: at(5), leadId: "l5", contactId: null }, { at: at(1), leadId: "other-deal", contactId: null }],
    },
  });

  assert.deepEqual(
    result.families.map((f) => [f.key, f.suggested, f.confirmed, f.after]),
    [
      ["follow_ups", 3, 2, { happened: 0, judged: 1, pending: 0 }],
      ["messages", 0, 0, { happened: 0, judged: 0, pending: 0 }],
      ["notes", 4, 4, { happened: 2, judged: 3, pending: 1 }],
      ["stage", 2, 2, { happened: 1, judged: 2, pending: 0 }],
      ["quotes", 2, 2, { happened: 2, judged: 2, pending: 0 }],
      ["meetings", 0, 0, { happened: 0, judged: 0, pending: 0 }],
      ["other", 1, 1, { happened: 0, judged: 0, pending: 0 }],
    ],
  );
  // Per person: confirmed, and the reply rate over their reply-kind cards only (not stage, quotes or Other).
  assert.deepEqual(result.people, [
    { userId: "u1", suggested: 7, confirmed: 6, replied: { happened: 1, judged: 2, pending: 1 } },
    { userId: "u2", suggested: 5, confirmed: 4, replied: { happened: 1, judged: 2, pending: 0 } },
    { userId: null, suggested: 0, confirmed: 1, replied: { happened: 0, judged: 0, pending: 0 } },
  ]);
});

test("the window: exactly 3 days still counts, a moment more does not; the same instant as the Confirm does not", () => {
  const judge = (replyAt: Date) =>
    row(summarizeOutcomes({
      now: NOW, staffIds: new Set(["u1"]), visible: everything, proposals: [],
      confirmations: [confirm("note", { leadId: "l1", contactId: "c1" })],
      happened: { ...nothing, reply: [{ at: replyAt, leadId: null, contactId: "c1" }] },
    }), "notes").after.happened;
  assert.equal(judge(at(3)), 1);
  assert.equal(judge(new Date(at(3).getTime() + 1)), 0);
  assert.equal(judge(T0), 0);
  // A deal move counts on that deal only — never on the customer's other deal.
  const moved = summarizeOutcomes({
    now: NOW, staffIds: new Set(["u1"]), visible: everything, proposals: [],
    confirmations: [confirm("stage", { leadId: "l1", contactId: "c1" })],
    happened: { ...nothing, progress: [{ at: at(1), leadId: "l2", contactId: "c1" }] },
  });
  assert.deepEqual(row(moved, "stage").after, { happened: 0, judged: 1, pending: 0 });
  // A quote judged at 14 days: one confirmed 13 days ago is still too recent.
  const recent = summarizeOutcomes({
    now: NOW, staffIds: new Set(["u1"]), visible: everything, proposals: [],
    confirmations: [confirm("quote_build", { leadId: "l1" }, "u1", at(17))],
    happened: nothing,
  });
  assert.deepEqual(row(recent, "quotes").after, { happened: 0, judged: 0, pending: 1 });
});

test("an owner who may open only some records is counted only cards whose EVERY record they may open — fail closed", () => {
  const restricted: Visible = {
    leadId: new Set(["mine"]), contactId: new Set(["my-customer"]), quoteId: new Set(["my-quote"]), vehicleId: new Set(), jobCardId: new Set(),
  };
  const result = summarizeOutcomes({
    now: NOW,
    staffIds: new Set(["u1", "u2"]),
    visible: restricted,
    proposals: [
      { kind: "note", leadId: "mine", userId: "u1" },
      { kind: "note", leadId: "theirs", userId: "u2" },
      { kind: "customer_note", contactId: "my-customer", userId: "u1" },
      { kind: "customer_note", contactId: "their-customer", userId: "u2" },
      // On a deal they may open, with a customer they may not: not counted — every record must be theirs to open.
      { kind: "follow_up", leadId: "mine", contactId: "their-customer", userId: "u1" },
      { kind: "follow_up", userId: "u1" }, // on nobody: their own calendar
      { kind: "block_time", userId: "u2" },
      { kind: "quote_pdf", quoteId: "their-quote", userId: "u1" }, // a customer-only quote they can't open
      { kind: "quote_pdf", quoteId: "my-quote", userId: "u1" },
      { kind: "attach_file", vehicleId: "v1", userId: "u2" },
      { kind: "record_payment", userId: "u2" }, // a record-linked kind with no record to check: never counted for them
      { kind: "plan", userId: "u1" },
    ],
    confirmations: [
      confirm("note", { leadId: "mine", contactId: "my-customer" }),
      confirm("note", { leadId: "theirs", contactId: "their-customer" }, "u2"),
      confirm("customer_note", { contactId: "their-customer" }, "u2"),
      confirm("block_time", {}, "u2"),
      confirm("quote_pdf", {}), // a quote on no deal or customer: no record to check
      confirm("record_payment", {}, "u2"),
      confirm(null, {}, "u2"), // an older entry nobody can read
    ],
    happened: { ...nothing, reply: [{ at: at(1), leadId: "theirs", contactId: "their-customer" }] },
  });
  assert.deepEqual(result.families.map((f) => [f.key, f.suggested, f.confirmed]).filter(([, s, c]) => s || c), [
    ["follow_ups", 1, 0],
    ["notes", 2, 1],
    ["quotes", 1, 0],
    ["other", 1, 1],
  ]);
  assert.deepEqual(row(result, "notes").after, { happened: 0, judged: 1, pending: 0 }, "the reply on a deal they can't open is not counted");
  assert.deepEqual(result.people.map((p) => [p.userId, p.suggested, p.confirmed]), [["u1", 4, 1], ["u2", 1, 1]]);
});

test("a Confirm on a customer-only quote: not counted for a viewer who can open the customer but not the quote (review of #940)", () => {
  const sees = (quotes: ReadonlySet<string> | null): Visible => ({ leadId: null, contactId: new Set(["anna"]), quoteId: quotes, vehicleId: null, jobCardId: null });
  const run = (visible: Visible, confirmations: Confirmation[]) =>
    row(summarizeOutcomes({ now: NOW, staffIds: new Set(["u1"]), visible, proposals: [], confirmations, happened: nothing }), "quotes").confirmed;
  const onQuote = { ...confirm("quote_pdf", { contactId: "anna" }), quoteId: "q-anna" };
  assert.equal(run(sees(new Set()), [onQuote]), 0, "the customer is theirs, the quote is not");
  assert.equal(run(sees(new Set(["q-anna"])), [onQuote]), 1, "…and with the quote theirs too, it counts");
  assert.equal(run(null, [onQuote]), 1, "the full owner counts it");
  // From before a Confirm kept its quote: the customer is not the whole story — not counted for them; counted for the owner.
  const older = confirm("quote_pdf", { contactId: "anna" });
  assert.equal(run(sees(new Set(["q-anna"])), [older]), 0);
  assert.equal(run(null, [older]), 1);
  // A built quote is made FOR the customer: an older one without its quote id still counts on the customer.
  assert.equal(run(sees(new Set()), [confirm("quote_build", { contactId: "anna" })]), 1);
  // What a Confirm keeps: the records on its card, read back from the entry's metadata the same way.
  assert.deepEqual(cardRecords({ kind: "quote_pdf", quoteId: "q-anna", leadId: null }), { quoteId: "q-anna" });
  assert.deepEqual(cardRecords({ kind: "attach_file", target: { jobCardId: "j1" } }), { jobCardId: "j1" });
});

test("who may be counted: everything for someone who sees everything; for anyone else, only the allow-listed kinds without a record", () => {
  assert.equal(mayCount({ kind: "plan" }, null), true);
  assert.equal(mayCount({ kind: null }, null), true);
  const sees = (slot: Partial<Visible & object>): Visible => ({ leadId: null, contactId: null, quoteId: null, vehicleId: null, jobCardId: null, ...slot });
  const noQuotes = sees({ quoteId: new Set() });
  assert.equal(mayCount({ kind: "quote_pdf", quoteId: "q" }, noQuotes), false);
  assert.equal(mayCount({ kind: "note", leadId: "l" }, noQuotes), true, "a slot they see all of passes");
  for (const kind of ["block_time", "follow_up", "meeting", "schedule", "create_customer", "create_lead"]) assert.equal(mayCount({ kind }, noQuotes), true, kind);
  for (const kind of ["quote_pdf", "quote_change", "quote_add", "record_payment", "schedule_delivery", "attach_file", "job_card", "watch", "plan", "note"]) {
    assert.equal(mayCount({ kind }, noQuotes), false, kind);
  }
  assert.equal(mayCount({ kind: null }, noQuotes), false);
  assert.deepEqual([...RECORDLESS_KINDS].sort(), ["block_time", "create_customer", "create_lead", "follow_up", "meeting", "schedule"]);
});

test("the numbers as the page writes them", () => {
  assert.equal(percent(9, 12), "75%");
  assert.equal(percent(3, 2), "100%", "never more than all of them");
  assert.equal(describeTally({ happened: 4, judged: 7, pending: 2 }), "4 of 7 (57%) · 2 too recent to tell");
  assert.equal(describeTally({ happened: 0, judged: 3, pending: 0 }), "0 of 3 (0%)");
  assert.equal(describeTally({ happened: 0, judged: 0, pending: 3 }), "3 too recent to tell");
  assert.equal(describeTally({ happened: 0, judged: 0, pending: 0 }), "—");
});

/* ── Wiring ──────────────────────────────────────────────────────────────── */

test("every Confirm of a card records the card's kind — in the audit stream's metadata, not the timeline summary", () => {
  const source = read("src/app/actions/assistant.ts");
  const entries = source.split("logAudit(").slice(1).map((chunk) => chunk.slice(0, chunk.search(/\);\n/)));
  const confirms = entries.filter((entry) => entry.includes('"assistant.action_confirmed"'));
  assert.equal(confirms.length, 12, "the confirm entries counted here");
  // The kind, and every record the card is on — so a Confirm is counted only for those who may open them.
  for (const entry of confirms) assert.match(entry, /metadata: \{ kind: card\.kind, \.\.\.cardRecords\(card\)/, entry);
  assert.match(source, /metadata: \{ kind: card\.kind, \.\.\.cardRecords\(card\), quoteId: saved\.quote\.id \}/, "a built quote names the quote it made");
  assert.doesNotMatch(source, /summary: `[^`]*\$\{card\.kind\}/, "the kind never goes into a summary — that is the customer's timeline");
});

test("askCrm records the cards it offered on the turn it saves", () => {
  const source = read("src/lib/crmAssistant.ts");
  const start = source.indexOf("const saved = await prisma.assistantTurn");
  const save = source.slice(start, source.indexOf(".then((row) => row.id)", start));
  assert.match(save, /proposed: proposedCards\(actions\)/);
  // `actions` there already holds the plan's card: the plan is pushed onto it before the save.
  assert.ok(source.indexOf("actions.push(...planCards)") < source.indexOf("const saved = await prisma.assistantTurn"));
});

test("the column is additive and re-runnable", () => {
  const sql = read("prisma/migrations/20261102140000_assistant_turn_proposed/migration.sql");
  assert.match(sql, /ALTER TABLE "AssistantTurn" ADD COLUMN IF NOT EXISTS "proposed" JSONB;/);
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ""), /DROP|DELETE|UPDATE|NOT NULL/i);
  assert.match(read("prisma/schema.prisma"), /\n {2}proposed {3}Json\?\n/);
});

test("every query the loader runs names the workspace, and the page keeps its owner-only gate", () => {
  const loader = read("src/lib/assistantOutcomes.ts");
  const wheres = [...loader.matchAll(/where: \{([^\n]*)/g)].map((m) => m[1]);
  assert.equal(wheres.length, 9);
  for (const where of wheres) assert.match(where, /^ tenantId\b/, where);
  assert.doesNotMatch(loader, /basePrisma|\$queryRaw/, "the scoped client and model queries only");
  const page = read("src/app/(app)/settings/assistant/page.tsx");
  assert.match(page, /const viewer = await requireTenantOwner\(\);\n {2}if \(!\(await isModuleEnabled\("automation"\)\)\) notFound\(\);/);
  assert.match(page, /assistantOutcomes\(tenantId, viewer, new Set\(staff\.map\(\(s\) => s\.id\)\), \{ days: PERIOD_DAYS \}\)/);
  assert.match(page, /ratingsSince\(PERIOD_DAYS\)/, "the same period as the ratings");
  assert.match(page, /What happened after — not proof that \{profile\.name\} caused it\./);
});

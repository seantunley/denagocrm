import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_LISTED, isGone, listedBlock, listedRecords, referenceLine, resolveReference, splitListed, type ListedSlot } from "../src/lib/assistantListedRules";
import { conversationBlock } from "../src/lib/crmAssistantPlan";

// Five quotes as find_quotes returns them (newest first) — the answer lists them in ANOTHER order.
const quotes = [1029, 1030, 1031, 1032, 1033].map((n, i) => ({
  quote: `Q-${n}`, link: `/quotes/q${n}`, leadId: `lead${i}`, customer: ["Anna Smith", "Ben Botha", "Anna Smith", "Donovan Pillay", "Cara Jacobs"][i], total: "R 185 000",
}));
const fiveAnswer = [
  "Your five open quotes, oldest first:",
  "1. Q-1033 — Cara Jacobs, R 185 000 [[/quotes/q1033]]",
  "2. Q1031 — Anna Smith, viewed yesterday",
  "3. Q-1030 — Ben Botha",
  "4. Q-1032 — Donovan Pillay, not opened ⚠️",
  "5. Q-1029 — Anna Smith",
].join("\n");

test("capture: the records in the order the ANSWER shows them, by link or quote number", () => {
  const listed = listedRecords(fiveAnswer, [quotes]);
  assert.deepEqual(listed.map((r) => r.id), ["q1033", "q1031", "q1030", "q1032", "q1029"]);
  assert.deepEqual(listed[3], { kind: "quote", id: "q1032", label: "Q-1032 · Donovan Pillay" });
});

test("capture: never a record the lookups didn't return, and a quote is placed only by its number or link", () => {
  // A made-up link and a quote number nobody looked up.
  assert.deepEqual(listedRecords("See [[/quotes/invented]] and Q-9999.", [quotes]), []);
  // Anna is named, but neither of her quotes is: no quote is listed.
  assert.deepEqual(listedRecords("Anna Smith has two quotes out.", [quotes]), []);
});

test("capture: a deal and its customer record under one name are ONE place; nested records are found", () => {
  const brief = [{
    link: "/leads/L1", customer: "Anna Smith", lead: "Nomad XL",
    contact: { link: "/contacts/C1", customer: "Anna Smith" },
    quotes: [{ quote: "Q-1029", link: "/quotes/q1029" }, { quote: "Q-1031", link: "/quotes/q1031" }],
  }];
  const listed = listedRecords("Anna Smith (Nomad XL) has Q-1031 open and Q-1029 superseded.", [brief]);
  assert.deepEqual(listed.map((r) => `${r.kind}:${r.id}`), ["lead:L1", "quote:q1031", "quote:q1029"]);
  assert.equal(listed[0].label, "Anna Smith — Nomad XL");
});

test("capture: names match whole words only, and the list is capped", () => {
  const leads = [{ link: "/leads/L1", customer: "Ann" }, { link: "/leads/L2", customer: "Joanne Ann" }];
  assert.deepEqual(listedRecords("Annabel called.", [leads]), []);
  const many = Array.from({ length: 15 }, (_, i) => ({ quote: `Q-${2000 + i}`, link: `/quotes/x${i}` }));
  assert.equal(listedRecords(many.map((q) => q.quote).join(", "), [many]).length, MAX_LISTED);
});

test("saved state: the list travels apart from working memory; garbage is dropped", () => {
  const listed = listedRecords(fiveAnswer, [quotes]);
  assert.deepEqual(splitListed({ customer: "Anna", listed }), { listed, rest: { customer: "Anna" } });
  assert.deepEqual(splitListed({ listed }), { listed, rest: null });
  assert.deepEqual(splitListed({ topic: "quotes", listed: [{ kind: "quote", id: "bad id; DROP", label: "x" }] }).listed, []);
  assert.deepEqual(splitListed(null), { listed: [], rest: null });
  // conversationBlock still gets the model's working memory, never the list.
  const block = conversationBlock([{ question: "List my quotes", answer: fiveAnswer, state: splitListed({ topic: "open quotes", listed }).rest }]);
  assert.match(block, /Topic: open quotes/);
  assert.doesNotMatch(block, /q1032/);
});

const slots: ListedSlot[] = listedRecords(fiveAnswer, [quotes]);
const idOf = (slot: ListedSlot) => (isGone(slot) ? null : slot.id);

test("ordinals: plain places resolve to the record at that place", () => {
  const at = (q: string) => resolveReference(q, slots)?.matches.map((m) => idOf(m.slot));
  assert.deepEqual(at("draft a WhatsApp for the fourth one"), ["q1032"]);
  assert.deepEqual(at("Draft a WhatsApp for the 4th quote please"), ["q1032"]);
  assert.deepEqual(at("what about the last one?"), ["q1029"]);
  assert.deepEqual(at("number two"), ["q1031"]);
  assert.deepEqual(at("send #3 again"), ["q1030"]);
  assert.deepEqual(at("and the second?"), ["q1031"]);
  assert.deepEqual(at("Remind me about the third on the list"), ["q1030"]);
});

test("ordinals: no reading where there is no plain place", () => {
  for (const q of ["make a second quote for Anna", "book it for the first of December", "what's on in the second week", "her other quote", "compare the first and the third one", "the quote number 1032", "number 3 carts"]) {
    assert.equal(resolveReference(q, slots), null, q);
  }
});

test("ordinals: past the end of the list says so", () => {
  const ref = resolveReference("the sixth one", slots)!;
  assert.deepEqual(ref.matches, []);
  assert.match(referenceLine(ref, slots.length), /past the end of that list \(it had 5\)/);
});

test("ambiguity: 'one' over deals AND quotes may mean either — both named, ONE question", () => {
  const mixed: ListedSlot[] = [
    { kind: "lead", id: "L1", label: "Anna Smith — Nomad XL" },
    { kind: "quote", id: "q1", label: "Q-1 · Anna Smith" },
    { kind: "lead", id: "L2", label: "Donovan Pillay — Rover" },
    { kind: "quote", id: "q2", label: "Q-2 · Donovan Pillay" },
  ];
  const ref = resolveReference("the second one", mixed)!;
  assert.deepEqual(ref.matches.map((m) => m.place), [2, 3, 4]);
  assert.match(referenceLine(ref, 4), /Ask ONE short question naming them; do not guess/);
  // A noun settles it: the second QUOTE is Donovan's.
  assert.deepEqual(resolveReference("the second quote", mixed)!.matches.map((m) => idOf(m.slot)), ["q2"]);
  assert.deepEqual(resolveReference("the first deal", mixed)!.matches.map((m) => idOf(m.slot)), ["L1"]);
});

test("review of #947: a first quote they lost is still the first quote — never swapped for the second", () => {
  // DAX listed Q-100 then Q-200; Q-100 has since gone out of their reach.
  const now: ListedSlot[] = [{ kind: "quote", gone: true }, { kind: "quote", id: "q200", label: "Q-200 · Anna Smith" }];
  const first = resolveReference("send the first quote again", now)!;
  assert.deepEqual(first.matches, [{ place: 1, slot: { kind: "quote", gone: true } }]);
  assert.match(referenceLine(first, 2), /can no longer open .* never act on it and never swap in another record/);
  assert.deepEqual(resolveReference("the second quote", now)!.matches.map((m) => idOf(m.slot)), ["q200"]);
  // Among deals and quotes: a lost deal still counts as the first deal.
  const mixed: ListedSlot[] = [{ kind: "lead", gone: true }, { kind: "quote", id: "q1", label: "Q-1" }, { kind: "lead", id: "L2", label: "Donovan" }];
  assert.deepEqual(resolveReference("the first deal", mixed)!.matches.map((m) => m.place), [1]);
  assert.deepEqual(resolveReference("the second deal", mixed)!.matches.map((m) => idOf(m.slot)), ["L2"]);
});

test("restricted rep: a record they lost since keeps its place, empty — never acted on, never renumbered", () => {
  // listedNow (assistantListed) emptied #4: Donovan's deal was reassigned away from this rep.
  const now: ListedSlot[] = slots.map((s, i) => (i === 3 ? { kind: s.kind, gone: true as const } : s));
  const fourth = resolveReference("draft a WhatsApp for the fourth one", now)!;
  assert.deepEqual(fourth.matches, [{ place: 4, slot: { kind: "quote", gone: true } }]);
  assert.match(referenceLine(fourth, 5), /can no longer open .* never act on it and never swap in another record/);
  // The fifth is still the fifth.
  assert.equal(idOf(resolveReference("the fifth one", now)!.matches[0].slot), "q1029");
  // The block never names the lost record.
  const block = listedBlock(now, "draft a WhatsApp for the fourth one");
  assert.doesNotMatch(block, /Donovan|q1032/);
  assert.match(block, /#4 \(no longer available to this person\)/);
  assert.match(block, /#5 quote Q-1029 · Anna Smith \(id q1029\)/);
});

test("the block: numbered as seen, the reading of this question, and look-it-up-again", () => {
  const block = listedBlock(slots, "draft a WhatsApp for the fourth one");
  assert.match(block, /^#1 quote Q-1033 · Cara Jacobs \(id q1033\)$/m);
  assert.match(block, /"the fourth one" is #4 quote Q-1032 · Donovan Pillay \(id q1032\)/);
  assert.match(block, /look it up again/);
  assert.equal(listedBlock([], "the fourth one"), "");
  assert.doesNotMatch(listedBlock(slots, "her other quote"), /In the question/);
});

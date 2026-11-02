import assert from "node:assert/strict";
import { test } from "node:test";
import { FOLLOW_SCENARIOS, scoreFollow, type FollowTurn } from "../evals/daxFollowsReferences";

const scenario = (id: string) => FOLLOW_SCENARIOS.find((s) => s.id === id)!;
const listed = ["Q-1035 · Anna Voorbeeld", "Q-1034 · Anna Voorbeeld", "Q-1033 · Ben Voorbeeld", "Q-1032 · Cara Voorbeeld", "Q-1031 · Dev Voorbeeld"];
const first: FollowTurn = { question: "List my open quotes", answer: "Your five open quotes…", actions: [], listed };

test("the pass condition: the right record, details kept, nothing re-asked, one action", () => {
  const good = scoreFollow(scenario("fourth-quote"), [first, { question: "", answer: "Here's a draft for Cara.", listed: [], actions: [{ kind: "draft_message", leadLabel: "Cara Voorbeeld" }] }]);
  assert.equal(good.score, 100, JSON.stringify(good.checks));
  // The fifth instead of the fourth; or two cards; or asking which one when the place was plain.
  const wrong = scoreFollow(scenario("fourth-quote"), [first, { question: "", answer: "Draft for Dev.", listed: [], actions: [{ kind: "draft_message", leadLabel: "Dev Voorbeeld" }] }]);
  assert.ok(wrong.checks.some((c) => c.name === "picks the record at that place" && !c.ok));
  const asked = scoreFollow(scenario("fourth-quote"), [first, { question: "", answer: "Which quote do you mean?", listed: [], actions: [] }]);
  assert.ok(asked.score < 50);
});

test("details already given must survive into the action", () => {
  const deals = { ...first, listed: ["Eli Voorbeeld — Rover XL", "Dev Voorbeeld — Rover XL"] };
  const kept = scoreFollow(scenario("keeps-details"), [deals, { question: "", answer: "Set for tomorrow 10:00.", listed: [], actions: [{ kind: "follow_up", leadLabel: "Dev Voorbeeld", summary: "Call about the white Rover" }] }]);
  assert.equal(kept.score, 100, JSON.stringify(kept.checks));
  const lost = scoreFollow(scenario("keeps-details"), [deals, { question: "", answer: "Set.", listed: [], actions: [{ kind: "follow_up", leadLabel: "Dev Voorbeeld", summary: "Call" }] }]);
  assert.ok(lost.checks.some((c) => c.name === 'keeps "white"' && !c.ok));
});

test("ambiguity is ONE question and no card; a lost record is refused, never swapped", () => {
  assert.equal(scoreFollow(scenario("deal-or-quote"), [first, { question: "", answer: "Do you mean Anna's deal or Ben's quote?", listed: [], actions: [] }]).score, 100);
  const deals = { ...first, listed: ["Eli Voorbeeld — Rover XL", "Dev Voorbeeld — Rover XL", "Cara Voorbeeld — Rover XL"] };
  assert.equal(scoreFollow(scenario("reassigned-away"), [deals, { question: "", answer: "That deal is no longer yours to open, so I haven't set anything up.", listed: [], actions: [] }]).score, 100);
  const swapped = scoreFollow(scenario("reassigned-away"), [deals, { question: "", answer: "Reminder set for Cara.", listed: [], actions: [{ kind: "follow_up", leadLabel: "Cara Voorbeeld" }] }]);
  assert.ok(swapped.checks.filter((c) => !c.ok).length >= 2, JSON.stringify(swapped.checks));
});

test("a missing turn scores zero", () => {
  assert.equal(scoreFollow(scenario("her-other-quote"), [first]).score, 0);
});

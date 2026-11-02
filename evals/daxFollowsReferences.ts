/**
 * "DRAFT A WHATSAPP FOR THE FOURTH ONE": multi-turn evals for DAX following what it just showed — pure, so CI scores
 * recorded conversations without a model. evals/runFollowsReferencesEval.ts asks them live (it needs the AI key).
 *
 * The pass condition, from the review DAX's list memory came out of (2026-11-02):
 *  - picks the CORRECT record — the one at that place on the list it showed;
 *  - KEEPS the details already given (the colour, the time, the wording);
 *  - ASKS only for what it still needs — one specific question when two records genuinely fit, none otherwise;
 *  - leaves EXACTLY ONE valid action to confirm (none when it must ask, or the record is out of reach).
 */

export type FollowAsker = "manager" | "rep";

export type FollowScenario = {
  id: string;
  /** Asked in order, in one conversation. */
  turns: string[];
  /** Who asks: the rep owns the seeded deals and sees only those; the manager sees everyone's. */
  asker: FollowAsker;
  /** Done by the runner between the last two turns (the restricted-rep case). */
  between?: "reassign-second";
  expect: {
    /** The record the final action must be on: its place on the latest list DAX showed. */
    place?: number | "last";
    /** That record's quote number must be in the answer or the action ("her OTHER quote"). */
    quoteAt?: number;
    kind?: string;
    /** Details the person already gave, kept into the answer or the action. */
    keep?: string[];
    /** The right reply is ONE question, and no action. */
    ask?: boolean;
    /** The record is out of reach: said so, no action, never another record instead. */
    refuse?: boolean;
    /** Words the answer must have (a follow-up like "same for Donovan"). */
    mentions?: string[];
  };
};

export const FOLLOW_SCENARIOS: FollowScenario[] = [
  { id: "fourth-quote", asker: "rep", turns: ["List my open quotes", "Draft a WhatsApp for the fourth one"], expect: { place: 4, kind: "draft_message" } },
  { id: "keeps-details", asker: "rep", turns: ["Show my open deals", "Remind me to call the second one tomorrow at 10 about the white Rover"], expect: { place: 2, kind: "follow_up", keep: ["white", "10"] } },
  { id: "last-one", asker: "rep", turns: ["Which quotes are waiting for a signature?", "Add a note to the last one: customer wants delivery in December"], expect: { place: "last", kind: "note", keep: ["December"] } },
  { id: "her-other-quote", asker: "rep", turns: ["List my open quotes", "Tell me about the first one", "Draft a WhatsApp to her about her other quote"], expect: { place: 1, quoteAt: 2, kind: "draft_message" } },
  { id: "same-for-donovan", asker: "manager", turns: ["How many open deals does Eval Rep have, and which is the biggest?", "Same for Donovan Eval"], expect: { mentions: ["Donovan"] } },
  { id: "deal-or-quote", asker: "rep", turns: ["List my open deals and, separately, my open quotes", "Move the second one to Contacted"], expect: { ask: true } },
  { id: "past-the-end", asker: "rep", turns: ["Show my three biggest open deals", "Move the fifth one to Contacted"], expect: { ask: true } },
  { id: "reassigned-away", asker: "rep", between: "reassign-second", turns: ["List my open deals", "Remind me to call the second one tomorrow"], expect: { place: 2, refuse: true } },
];

export type FollowAction = { kind: string; leadLabel?: string | null } & Record<string, unknown>;
export type FollowTurn = {
  question: string;
  answer: string;
  actions: FollowAction[];
  /** The labels of the records this turn's answer listed, in order (its saved AssistantTurn.state.listed). */
  listed: string[];
};

/** "Q-1032 · Donovan Pillay" / "Anna Smith — Rover XL" → the customer's name. */
const nameOf = (label: string) => label.replace(/^Q-\d+ · /, "").split(" — ")[0].trim();
const has = (text: string, word: string) => text.toLowerCase().includes(word.toLowerCase());
const CLARIFYING = /\b(which|what|who)\b[^.?!\n]{0,60}\b(one|quote|deal|customer|record|time|day|date|colour|color)\b[^.?!\n]*\?/i;

/** One recorded conversation → its checks and a 0–100 score. */
export function scoreFollow(s: FollowScenario, turns: FollowTurn[]) {
  const last = turns.at(-1);
  if (!last || turns.length !== s.turns.length) return { scenarioId: s.id, score: 0, checks: [{ name: "every turn answered", ok: false }] };
  const list = turns.slice(0, -1).findLast((t) => t.listed.length)?.listed ?? [];
  const said = `${last.answer}\n${JSON.stringify(last.actions)}`;
  const e = s.expect;
  const target = e.place === undefined ? undefined : e.place === "last" ? list.at(-1) : list[e.place - 1];
  const wantActions = e.ask || e.refuse || e.place === undefined ? 0 : 1;
  const checks: { name: string; ok: boolean }[] = [{ name: "leaves exactly the valid actions to confirm", ok: last.actions.length === wantActions }];
  if (e.place !== undefined && !e.refuse) {
    checks.push({ name: "the earlier answer listed that place", ok: target !== undefined });
    checks.push({ name: "picks the record at that place", ok: !!target && last.actions.length === 1 && has(JSON.stringify(last.actions[0]), nameOf(target)) });
  }
  if (e.quoteAt !== undefined) {
    const number = /^Q-\d+/.exec(list[e.quoteAt - 1] ?? "")?.[0];
    checks.push({ name: "names the other quote", ok: !!number && has(said, number) });
  }
  if (e.kind) checks.push({ name: `the action is a ${e.kind}`, ok: last.actions.length === 1 && last.actions[0].kind === e.kind });
  for (const word of e.keep ?? []) checks.push({ name: `keeps "${word}"`, ok: has(said, word) });
  for (const word of e.mentions ?? []) checks.push({ name: `answers about ${word}`, ok: has(last.answer, word) });
  if (e.ask) checks.push({ name: "asks ONE specific question", ok: (last.answer.match(/\?/g) ?? []).length === 1 });
  else checks.push({ name: "asks for nothing it already has", ok: !CLARIFYING.test(last.answer) });
  if (e.refuse) {
    checks.push({ name: "says it can't be reached", ok: /no longer|can't|cannot|not (yours|available|able)|don't have access|isn't yours/i.test(last.answer) });
    checks.push({ name: "never another record instead", ok: !target || !list.filter((l) => l !== target).some((l) => has(JSON.stringify(last.actions), nameOf(l))) });
  }
  return { scenarioId: s.id, score: Math.round((100 * checks.filter((c) => c.ok).length) / checks.length), checks };
}

export function followReport(scores: ReturnType<typeof scoreFollow>[]): string {
  const lines = scores.map((s) => `${String(s.score).padStart(3)}  ${s.scenarioId}${s.checks.filter((c) => !c.ok).map((c) => `\n       ✗ ${c.name}`).join("")}`);
  const mean = Math.round(scores.reduce((sum, s) => sum + s.score, 0) / (scores.length || 1));
  return [...lines, `mean ${mean}`].join("\n");
}

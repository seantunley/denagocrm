import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  MIN_DEALS_EACH,
  dealFacts,
  findHabits,
  playbookName,
  playbookText,
  replyTiming,
  type DealFacts,
} from "../src/lib/outcomeLearningRules";
import { scanEntry } from "../src/lib/assistantMemory";

const code = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const H = 3_600_000;
const D = 24 * H;
const t0 = new Date("2026-06-01T08:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);

test("a deal's facts: first touch, touches before it closed, calls, follow-up after the quote and after it was opened", () => {
  const facts = dealFacts({
    won: true,
    createdAt: t0,
    closedAt: at(20 * D),
    touches: [
      { at: at(30 * D), channel: "call" }, // after it closed: not counted
      { at: at(5 * D), channel: "email" },
      { at: at(3 * H), channel: "whatsapp" },
      { at: at(8 * D), channel: "call" },
    ],
    quoteSentAt: at(4 * D),
    quoteViewedAt: at(7 * D),
  });
  assert.equal(facts.firstTouchHours, 3);
  assert.equal(facts.touches, 3);
  assert.equal(facts.hadCall, true);
  assert.equal(facts.quoteFollowUpDays, 1);
  assert.equal(facts.viewFollowUpDays, 1);
  const quiet = dealFacts({ won: false, createdAt: t0, closedAt: at(D), touches: [], quoteSentAt: null, quoteViewedAt: at(0) });
  assert.equal(quiet.firstTouchHours, null, "never touched");
  assert.equal(quiet.quoteFollowUpDays, undefined, "no quote went out");
  assert.equal(quiet.viewFollowUpDays, null, "opened, never followed up");
});

const deal = (won: boolean, over: Partial<DealFacts> = {}): DealFacts => ({ won, firstTouchHours: 48, touches: 1, hadCall: false, quoteFollowUpDays: undefined, viewFollowUpDays: undefined, ...over });
const many = <T,>(n: number, make: (i: number) => T) => Array.from({ length: n }, (_, i) => make(i));

test("a habit is reported only with enough deals on BOTH sides and a real gap, and only when it goes with winning", () => {
  // 12 won (9 phoned = 75%), 14 lost (4 phoned = 29%): reported, with the numbers.
  const deals = [...many(12, (i) => deal(true, { hadCall: i < 9 })), ...many(14, (i) => deal(false, { hadCall: i < 4 }))];
  const call = findHabits(deals).find((f) => f.key === "phone-call");
  assert.deepEqual(call && { wonPct: call.wonPct, lostPct: call.lostPct, wonDeals: call.wonDeals, lostDeals: call.lostDeals }, { wonPct: 75, lostPct: 29, wonDeals: 12, lostDeals: 14 });
  // One side short of the minimum: nothing said.
  const few = [...many(MIN_DEALS_EACH - 1, () => deal(true, { hadCall: true })), ...many(20, () => deal(false))];
  assert.equal(findHabits(few).length, 0);
  // A small gap (60% vs 50%): nothing said.
  const close = [...many(10, (i) => deal(true, { hadCall: i < 6 })), ...many(10, (i) => deal(false, { hadCall: i < 5 }))];
  assert.equal(findHabits(close).some((f) => f.key === "phone-call"), false);
  // Lost deals did it MORE: not advice.
  const backwards = [...many(10, () => deal(true)), ...many(10, () => deal(false, { hadCall: true }))];
  assert.equal(findHabits(backwards).some((f) => f.key === "phone-call"), false);
});

test("quote follow-ups count only deals whose quote went out", () => {
  const deals = [
    ...many(10, () => deal(true, { quoteFollowUpDays: 1 })),
    ...many(10, () => deal(false, { quoteFollowUpDays: null })),
    ...many(30, () => deal(false)), // no quote: not in this comparison
  ];
  const f = findHabits(deals).find((x) => x.key === "quote-follow-up");
  assert.deepEqual(f && [f.wonPct, f.lostPct, f.wonDeals, f.lostDeals], [100, 0, 10, 10]);
});

test("reply timing: the best part of the day against the worst, each with enough messages", () => {
  const msgs = [
    ...many(20, (i) => ({ saHour: 9, replied: i < 14 })), // morning 70%
    ...many(25, (i) => ({ saHour: 19, replied: i < 5 })), // evening 20%
    ...many(5, () => ({ saHour: 14, replied: true })), // afternoon: too few to judge
  ];
  assert.deepEqual(replyTiming(msgs), { best: "morning", worst: "evening", bestPct: 70, worstPct: 20, bestN: 20, worstN: 25 });
  assert.equal(replyTiming(msgs.slice(0, 20)), null, "one part of the day alone says nothing");
});

test("the playbook says only the numbers worked out, passes the memory scan, and nothing when nothing is clear", () => {
  const habits = [{ key: "phone-call", says: "Phone the customer at least once", wonPct: 75, lostPct: 29, wonDeals: 12, lostDeals: 14 }];
  const timing = { best: "morning", worst: "evening", bestPct: 70, worstPct: 20, bestN: 20, worstN: 25 };
  const text = playbookText(habits, timing, 180)!;
  const numbers = new Set((text.match(/\d+/g) ?? []).map(Number));
  assert.deepEqual([...numbers].sort((a, b) => a - b), [12, 14, 20, 25, 29, 70, 75, 180].sort((a, b) => a - b), "every figure comes from the findings");
  assert.equal(scanEntry(text).ok, true, "never read as a phone number or an instruction");
  assert.ok(text.length <= 1500, "within a playbook's size");
  assert.equal(playbookText([], null, 180), null);
  assert.equal(playbookName(new Date("2026-11-14T10:00:00Z")), "won-deal-habits-2026-11");
});

test("filed as an unreviewed playbook by nobody, so no one's DAX uses it until the owner approves", () => {
  const lib = code("src/lib/outcomeLearning.ts");
  assert.match(lib, /applyLearn\(null, \{ playbook: \[\{ name: playbookName\(now\), description: PLAYBOOK_DESCRIPTION, content: text \}\] \}, "outcomes"\)/);
  assert.doesNotMatch(lib, /codexRespond|anthropic/i, "no model call: the wording is the numbers'");
  // Every read names the workspace.
  for (const read of lib.match(/prisma\.\w+\.findMany\(\{\s*where: \{[^}]*/g) ?? []) assert.match(read, /where: \{ tenantId,/, read);
  assert.match(code("src/lib/assistantMemoryStore.ts"), /visibleTo = \(userId: string\) => \(\{ OR: \[\{ status: "approved" \}, \{ createdById: userId \}\] \}\)/);
  // Its own switch, owner only, visible in Settings → Assistant.
  const actions = code("src/app/actions/assistantSettings.ts");
  assert.match(actions, /export async function saveOutcomeLearning[\s\S]*?requireTenantOwner\(\)/);
  assert.match(actions, /export async function checkOutcomesNow[\s\S]*?requireTenantOwner\(\)/);
  assert.match(code("src/app/(app)/settings/assistant/page.tsx"), /Suggest playbook updates from won deals/);
  // Weekly, from the research cron.
  assert.match(code("src/app/api/cron/research/route.ts"), /await runOutcomeLearning\(tenantId\)/);
});

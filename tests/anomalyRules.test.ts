import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  anomalyDigestEmail,
  claimSpikes,
  duration,
  median,
  percentile,
  quoteDiscountPct,
  replySlip,
  unusualDiscounts,
  type DiscountQuote,
} from "../src/lib/anomalyRules";

const NOW = new Date("2026-11-23T08:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const code = (path: string) => readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const claims = (model: string, ages: number[]) => ages.map((age) => ({ model, claimedAt: daysAgo(age) }));

test("a model with at least 3 recent claims and twice its usual month is flagged", () => {
  const found = claimSpikes([...claims("Rover XL", [1, 5, 9, 20]), ...claims("Rover XL", [40, 70, 100])], NOW);
  assert.deepEqual(found, [{ model: "Rover XL", recent: 4, usual: 1 }]);
});

test("a steady model, a small number, and an old claim are not news", () => {
  // 3 recent against 9 in the 90 days before is exactly the usual month.
  assert.deepEqual(claimSpikes([...claims("Nomad", [2, 10, 25]), ...claims("Nomad", [35, 40, 45, 50, 60, 70, 80, 100, 110])], NOW), []);
  // Two claims is never a pattern, whatever came before.
  assert.deepEqual(claimSpikes(claims("City", [3, 4]), NOW), []);
  // Outside both windows, or dated in the future.
  assert.deepEqual(claimSpikes([...claims("City", [130, 200, 300]), { model: "City", claimedAt: daysAgo(-2) }], NOW), []);
});

test("a model with claims but no history says so, and model names match whatever their capitals", () => {
  const found = claimSpikes([...claims("rover xl", [1, 2]), ...claims("Rover XL ", [3])], NOW);
  assert.equal(found.length, 1);
  assert.equal(found[0].recent, 3);
  assert.equal(found[0].usual, 0);
});

const tickets = (rows: [age: number, minutes: number][]) =>
  rows.map(([age, minutes]) => ({ createdAt: daysAgo(age), firstResponseAt: new Date(daysAgo(age).getTime() + minutes * 60_000) }));
const spread = (from: number, n: number, minutes: number): [number, number][] => Array.from({ length: n }, (_, i) => [from + i * 3, minutes]);

test("first replies to customers that doubled against the team's earlier weeks are flagged, with no one named", () => {
  assert.deepEqual(replySlip([...tickets(spread(1, 5, 180)), ...tickets(spread(15, 12, 40))], NOW), { recentMinutes: 180, usualMinutes: 40, tickets: 5 });
});

test("too few tickets, a small slip, or a steadily slow team is not flagged", () => {
  // 4 recent tickets: not enough to judge.
  assert.equal(replySlip([...tickets(spread(1, 4, 600)), ...tickets(spread(15, 12, 30))], NOW), null);
  // Doubled, but only from 10 to 25 minutes.
  assert.equal(replySlip([...tickets(spread(1, 5, 25)), ...tickets(spread(15, 12, 10))], NOW), null);
  // Always takes four hours: slow, but nothing changed.
  assert.equal(replySlip([...tickets(spread(1, 5, 240)), ...tickets(spread(15, 12, 240))], NOW), null);
  // No earlier weeks to compare with.
  assert.equal(replySlip(tickets(spread(1, 6, 900)), NOW), null);
});

test("one ticket left over a weekend cannot trip it", () => {
  assert.equal(replySlip([...tickets([[1, 30], [2, 35], [3, 40], [4, 30], [5, 4000]]), ...tickets(spread(15, 12, 30))], NOW), null);
});

test("a reply recorded before the ticket opened is ignored, not counted as instant", () => {
  assert.equal(replySlip([...tickets(spread(1, 5, -50)), ...tickets(spread(15, 12, 40))], NOW), null);
});

test("reply times name no one, and leave out tickets staff opened themselves", () => {
  // No record of when a ticket changed hands, so the wait before it reached someone can't be put on them.
  const digest = readFileSync("src/lib/anomalyDigest.ts", "utf8");
  assert.match(digest, /source: \{ not: "staff" \}/);
  assert.match(digest, /select: \{ createdAt: true, firstResponseAt: true \}/);
  assert.doesNotMatch(digest, /assignedToId|personId|firstReplier/);
});

test("discounts are dated by when the quote was first sent, whatever happened to it after", () => {
  const digest = readFileSync("src/lib/anomalyDigest.ts", "utf8");
  // Drafted 20 days ago and sent today is a quote sent today; one sent then declined is still in the baseline.
  assert.match(digest, /sentAt: \{ gte: windowStart\(now, DISCOUNT_RECENT_DAYS \+ DISCOUNT_BASELINE_DAYS\) \}/);
  assert.doesNotMatch(digest, /status: \{ in: \["sent", "accepted"\] \}/);
  // Every SENT version counts: (a) sent, then an unsent draft revision — the sent one stays; (b) both sent — two offers;
  // (c) a baseline quote later revised stays in the baseline. Only sentAt decides; a draft revision has none.
  assert.doesNotMatch(digest, /supersededAt/, "a sent quote isn't dropped for being revised later");
  // The date is the database's: stamped on the first move to sent/accepted, by any writer, and never moved.
  const sql = readFileSync("prisma/migrations/20261123180000_quote_sent_at/migration.sql", "utf8");
  assert.match(sql, /IF NEW\."sentAt" IS NULL AND NEW\."status" IN \('sent', 'accepted'\) THEN\s+NEW\."sentAt" := now\(\);/);
  assert.match(sql, /IF TG_OP = 'UPDATE' AND OLD\."sentAt" IS NOT NULL THEN\s+NEW\."sentAt" := OLD\."sentAt";/);
  assert.match(sql, /BEFORE INSERT OR UPDATE ON "Quote"/);
});

test("an add-on the customer didn't choose is not part of a quote's discount", () => {
  const base = { qty: 1, unitPriceCents: 100_000, discountPct: 10, kind: "product" };
  const unchosen = { qty: 1, unitPriceCents: 100_000, discountPct: 100, kind: "accessory", optional: true, selected: false };
  assert.equal(quoteDiscountPct([base, unchosen]), 10);
  // Chosen, it counts like any other line.
  assert.equal(Math.round(quoteDiscountPct([base, { ...unchosen, selected: true }]) ?? 0), 55);
  assert.match(readFileSync("src/lib/anomalyDigest.ts", "utf8"), /kind: true, optional: true, selected: true/);
});

test("a quote's discount is one percentage of its list value", () => {
  assert.equal(quoteDiscountPct([{ qty: 1, unitPriceCents: 100_000, discountPct: 10, kind: "product" }, { qty: 2, unitPriceCents: 50_000, discountPct: 0, kind: "accessory" }]), 5);
  // A trade-in and a free line are not discounts.
  assert.equal(quoteDiscountPct([{ qty: 1, unitPriceCents: 100_000, discountPct: 0, kind: "product" }, { qty: 1, unitPriceCents: 40_000, discountPct: 100, kind: "trade_in" }, { qty: 1, unitPriceCents: 0, discountPct: 100, kind: "accessory" }]), 0);
  assert.equal(quoteDiscountPct([]), null);
  // A nonsense percentage is held to 0–100.
  assert.equal(quoteDiscountPct([{ qty: 1, unitPriceCents: 1000, discountPct: 250, kind: "product" }]), 100);
});

test("median and percentile", () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), 0);
  assert.equal(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 0.95), 19);
  assert.equal(percentile([7], 0.95), 7);
});

const quote = (number: number, age: number, pct: number, by: string | null = "Sipho"): DiscountQuote => ({ id: `q${number}`, number, by, sentAt: daysAgo(age), pct });
const history = (n: number, pct: (i: number) => number) => Array.from({ length: n }, (_, i) => quote(100 + i, 10 + i * 3, pct(i)));

test("a discount well above what the workspace usually gives is listed, highest first", () => {
  const found = unusualDiscounts([...history(25, (i) => (i % 5 === 0 ? 5 : 0)), quote(1, 1, 12), quote(2, 2, 20), quote(3, 3, 6)], NOW);
  assert.equal(found?.usualTopPct, 5);
  assert.deepEqual(found?.quotes.map((q) => q.number), [2, 1]);
});

test("a workspace without enough history, or with nothing above its norm, hears nothing", () => {
  assert.equal(unusualDiscounts([...history(19, () => 0), quote(1, 1, 40)], NOW), null);
  assert.equal(unusualDiscounts([...history(25, () => 10), quote(1, 1, 11)], NOW), null);
  // Never discounts: a 3% goodwill gesture is under the 5% floor.
  assert.equal(unusualDiscounts([...history(25, () => 0), quote(1, 1, 3)], NOW), null);
});

test("a quiet week sends no email at all", () => {
  assert.equal(anomalyDigestEmail({ brand: "Denago", origin: "https://crm.example", claims: [], replies: null, discounts: null }), null);
});

test("the email shows each recent figure beside the usual one, links to the record, and says how to stop it", () => {
  const email = anomalyDigestEmail({
    brand: "Denago Cape Town",
    origin: "https://crm.example",
    claims: [{ model: "Rover XL", recent: 4, usual: 1 }, { model: "Nomad", recent: 3, usual: 0 }],
    replies: { recentMinutes: 200, usualMinutes: 40, tickets: 6 },
    discounts: { usualTopPct: 5, quotes: [quote(2, 2, 20), quote(1, 1, 12.5, null)] },
  })!;
  assert.equal(email.subject, "Denago Cape Town: 5 things out of the ordinary this week");
  assert.match(email.text, /Rover XL: 4 claims in the last 30 days \(usually about 1\)/);
  assert.match(email.text, /Nomad: 3 claims in the last 30 days \(usually none\)/);
  assert.match(email.text, /Typically 3 h 20 min from a customer opening a ticket to its first reply over the last 14 days \(usually 40 min\), across 6 tickets/);
  assert.match(email.text, /For the whole team, from when the ticket was opened/);
  // Whoever made the quote — not necessarily who set the discount.
  assert.match(email.text, /Q-2: 20% off · created by Sipho\n {4}https:\/\/crm\.example\/quotes\/q2/);
  assert.match(email.text, /Q-1: 12\.5% off\n/);
  assert.match(email.text, /stayed at or under 5%/);
  assert.match(email.text, /Settings → Automatic jobs & messages/);
  assert.match(email.text, /Nothing here is a verdict/);
});

test("a long list of discounted quotes is cut to ten with the rest counted", () => {
  const many = Array.from({ length: 13 }, (_, i) => quote(i + 1, 1, 30 - i));
  const email = anomalyDigestEmail({ brand: "D", origin: "", claims: [], replies: null, discounts: { usualTopPct: 5, quotes: many } })!;
  assert.equal(email.text.match(/^ {2}- Q-/gm)?.length, 10);
  assert.match(email.text, /…and 3 more\./);
  assert.match(email.subject, /13 things/);
});

test("a name from a record cannot add lines to the email", () => {
  const email = anomalyDigestEmail({ brand: "D", origin: "", claims: [{ model: "Rover\nURGENT: pay invoice\n", recent: 3, usual: 0 }], replies: null, discounts: null })!;
  assert.doesNotMatch(email.text, /^URGENT/m);
});

test("durations read the way a person says them", () => {
  assert.equal(duration(45), "45 min");
  assert.equal(duration(120), "2 h");
  assert.equal(duration(60 * 72), "3 days");
});

test("every read names the workspace, the digest is switched and claimed before it sends, and no AI is called", () => {
  const run = code("src/lib/anomalyDigest.ts");
  const reads = run.match(/prisma\.(warrantyClaim|customerCase|quote)\.findMany\(\{\s*where: \{\s*tenantId,/g) ?? [];
  assert.equal(reads.length, 3);
  assert.doesNotMatch(run, /aiText|assistant/i);
  const order = ["automationOn(ANOMALY_DIGEST_SWITCH, tenantId)", "digestWeekDue(", "// Claim", "findAnomalies(tenantId, now)", "sendEmail("].map((mark) => readFileSync("src/lib/anomalyDigest.ts", "utf8").indexOf(mark, readFileSync("src/lib/anomalyDigest.ts", "utf8").indexOf("export async function runAnomalyDigest")));
  assert.ok(order.every((at) => at > 0), "all steps present");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "switch, due, claim, read, send — in that order");
  assert.match(run, /await handBack\(\)/);
  assert.match(code("src/app/api/cron/automations/route.ts"), /phase\("anomaly-digest", \(\) => runAnomalyDigest\(tenantId\), null\)/);
});

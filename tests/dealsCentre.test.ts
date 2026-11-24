import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { currentMilestone, dealBlockers, dealMilestones, dealProgress, readyForDelivery, type DealFacts } from "../src/lib/dealMilestones";
import { blockerCounts, dealTotals, dealsView } from "../src/lib/dealsCentreRules";

/** Brief §3 (Deals Centre) and the shared milestone rules §4/§5 build on. */
const facts = (over: Partial<DealFacts> = {}): DealFacts => ({
  accepted: true,
  depositCents: 500_00,
  depositPaid: true,
  stock: [{ pdiStatus: "passed" }],
  deliveryBooked: true,
  delivered: false,
  financeHolds: false,
  ...over,
});

test("milestones: the deal page's rules, with a step that does not apply SKIPPED, not missing", () => {
  const steps = dealMilestones(facts({ depositCents: 0, depositPaid: false, stock: [] }));
  assert.deepEqual(steps.map((s) => [s.key, s.done, s.skipped]), [
    ["quote", true, false],
    ["accepted", true, false],
    ["deposit", false, true],
    ["stock", false, false],
    ["pdi", false, false],
    ["delivery", false, false],
  ]);
  assert.equal(currentMilestone(steps).key, "stock", "a skipped deposit is not where the deal is stuck");
  // Delivered = every step done, whatever was recorded on the way.
  assert.ok(dealMilestones(facts({ delivered: true, stock: [] })).every((s) => s.done && !s.skipped));
  // PDI needs EVERY allocated unit through it.
  assert.equal(dealMilestones(facts({ stock: [{ pdiStatus: "passed" }, { pdiStatus: "in_progress" }] }))[4].done, false);
});

test("blockers are facts the deal has — and none once it is delivered", () => {
  const texts = (f: DealFacts) => dealBlockers(f).map((b) => b.text);
  assert.deepEqual(dealBlockers(facts({ accepted: false })), [{ key: "accept", text: "Not accepted yet" }]);
  assert.deepEqual(texts(facts({ depositPaid: false, financeHolds: true, stock: [], deliveryBooked: false })), [
    "Deposit not received",
    "Finance not approved — delivery is held",
    "No stock allocated",
    "Delivery not booked",
  ]);
  assert.deepEqual(texts(facts({ depositCents: 0, depositPaid: false })), [], "no deposit asked is not a missing deposit");
  assert.deepEqual(texts(facts({ stock: [{ pdiStatus: "in_progress" }] })), ["PDI not passed"]);
  assert.deepEqual(texts(facts({ delivered: true, accepted: false })), []);
  // Progress counts only the steps that apply.
  assert.deepEqual(dealProgress(dealMilestones(facts({ depositCents: 0, depositPaid: false, stock: [] }))), { done: 2, of: 5 });
  assert.deepEqual(blockerCounts([{ blockers: dealBlockers(facts({ stock: [] })) }, { blockers: dealBlockers(facts({ accepted: false })) }]), {
    accept: 1, deposit: 0, finance: 0, stock: 1, pdi: 0, delivery: 0,
  });
  assert.equal(readyForDelivery(facts()), true);
  assert.equal(readyForDelivery(facts({ financeHolds: true })), false, "finance holds delivery");
  assert.equal(readyForDelivery(facts({ depositCents: 0, depositPaid: false })), true);
  assert.equal(readyForDelivery(facts({ delivered: true })), false, "already handed over");
});

test("totals are per currency, committed apart from proposed, and drafts count in neither", () => {
  const totals = dealTotals([
    { currency: null, status: "accepted", totalCents: 100_000, receivedCents: 30_000, balanceCents: 70_000 },
    { currency: null, status: "sent", totalCents: 50_000, receivedCents: 0, balanceCents: 0 },
    { currency: null, status: "draft", totalCents: 999_999, receivedCents: 0, balanceCents: 0 },
    { currency: "USD", status: "accepted", totalCents: 10_000, receivedCents: 12_000, balanceCents: -2_000 },
  ]);
  assert.deepEqual(totals, [
    { currency: null, count: 3, proposed: 50_000, committed: 100_000, received: 30_000, owed: 70_000 },
    // Overpaid is not negative owed.
    { currency: "USD", count: 1, proposed: 0, committed: 10_000, received: 12_000, owed: 0 },
  ]);
});

test("views: unknown → Active; Finance pending only with the Finance module", () => {
  assert.equal(dealsView(undefined, true), "active");
  assert.equal(dealsView("ready", false), "ready");
  assert.equal(dealsView("finance", false), "active");
  assert.equal(dealsView("finance", true), "finance");
});

test("the loader reads the quote list's own scope and the canonical money rules", () => {
  const loader = readFileSync("src/lib/dealsCentre.ts", "utf8");
  // RBAC + search + current revisions only (supersededAt: null) — the quotes list's own filter.
  assert.match(loader, /const \{ where: scope \} = await quoteListFilter\(user, \{ q \}\)/);
  // Every in-play view, count and card is a cut of ONE read, under the quote list's scope.
  assert.match(loader, /const inPlay = await readRows\(\{ AND: \[scope, IN_PLAY\] \}, financeByQuote\)/);
  assert.match(loader, /const IN_PLAY: Prisma\.QuoteWhereInput = \{ status: \{ in: \["sent", "accepted"\] \}, deliveredAt: null \}/);
  assert.match(loader, /prisma\.quote\.count\(\{ where: scope \}\)/);
  assert.match(loader, /Math\.round\(payableTotalCents\(quote\)\)/);
  assert.match(loader, /receivedCents\(quote, payments\)/);
  assert.match(loader, /stockReservations: \{ where: \{ status: "active" \}/, "a released reservation allocates nothing");
  // Only an accepted quote is an invoice: a sent one owes nothing.
  assert.match(loader, /balanceCents: quote\.status === "accepted" \? total - received : 0/);
  const page = readFileSync("src/app/(app)/deals/page.tsx", "utf8");
  assert.match(page, /await requireRoute\("\/deals"\)/);
});

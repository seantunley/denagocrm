import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { currentMilestone, dealBlockers, dealMilestones, readyForDelivery, type DealFacts } from "../src/lib/dealMilestones";
import { dealTotals, dealsView } from "../src/lib/dealsCentreRules";

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
  assert.deepEqual(dealBlockers(facts({ accepted: false })), ["Not accepted yet"]);
  assert.deepEqual(dealBlockers(facts({ depositPaid: false, financeHolds: true, stock: [], deliveryBooked: false })), [
    "Deposit not received",
    "Finance not approved — delivery is held",
    "No stock allocated",
    "Delivery not booked",
  ]);
  assert.deepEqual(dealBlockers(facts({ depositCents: 0, depositPaid: false })), [], "no deposit asked is not a missing deposit");
  assert.deepEqual(dealBlockers(facts({ stock: [{ pdiStatus: "in_progress" }] })), ["PDI not passed"]);
  assert.deepEqual(dealBlockers(facts({ delivered: true, accepted: false })), []);
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
  assert.match(loader, /AND: \[scope, viewWhere\(view, pendingFinance\)\]/);
  assert.match(loader, /Math\.round\(payableTotalCents\(quote\)\)/);
  assert.match(loader, /receivedCents\(quote, payments\)/);
  // Only an accepted quote is an invoice: a sent one owes nothing.
  assert.match(loader, /balanceCents: quote\.status === "accepted" \? total - received : 0/);
  const page = readFileSync("src/app/(app)/deals/page.tsx", "utf8");
  assert.match(page, /await requireRoute\("\/deals"\)/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AUTOMOTIVE_LIFECYCLE, dealBlockers, dealMilestones, readyForDelivery, type DealFacts } from "../src/lib/dealMilestones";
import { LIFECYCLE_TEMPLATES, lifecycleFor, lifecycleTemplate, readinessLabels } from "../src/lib/dealLifecycle";

/** Brief §5 (Phase 4): industry lifecycles without breaking the automotive rules. */
const ALL = new Set(["automotive", "commerce", "finance"]);
const facts = (over: Partial<DealFacts> = {}): DealFacts => ({
  accepted: true,
  depositCents: 1000_00,
  depositPaid: true,
  stock: [],
  deliveryBooked: true,
  delivered: false,
  ...over,
});

test("an unknown or unset choice is Automotive — every existing workspace keeps what it had", () => {
  assert.equal(lifecycleTemplate(null), "automotive");
  assert.equal(lifecycleTemplate("nonsense"), "automotive");
  assert.deepEqual(lifecycleFor("automotive", ALL), AUTOMOTIVE_LIFECYCLE);
  // The automotive journey is the six steps it always was.
  assert.deepEqual(dealMilestones(facts()).map((s) => s.label), ["Quote", "Accepted", "Deposit", "Stock", "PDI", "Delivery"]);
});

test("a non-automotive template works with no vehicle-only steps — nothing stands in for stock or PDI", () => {
  const services = lifecycleFor("services", ALL);
  const steps = dealMilestones(facts(), services);
  assert.deepEqual(steps.map((s) => s.label), ["Proposal", "Engagement", "Retainer", "Completion"]);
  // No unit, no inspection: neither is a blocker, and the deal can be ready.
  assert.deepEqual(dealBlockers(facts(), services), []);
  assert.equal(readyForDelivery(facts(), services), true);
  assert.equal(readyForDelivery(facts(), AUTOMOTIVE_LIFECYCLE), false, "the same deal on Automotive still needs a unit through PDI");
  // Its own words in what IS in the way.
  assert.deepEqual(dealBlockers(facts({ depositPaid: false, deliveryBooked: false }), services).map((b) => b.text), ["Retainer not received", "Completion not booked"]);
  assert.deepEqual(dealBlockers(facts({ accepted: false }), services).map((b) => b.text), ["Not engagement yet"]);
});

test("wholesale keeps stock but has no inspection step", () => {
  const wholesale = lifecycleFor("wholesale", ALL);
  assert.deepEqual(dealBlockers(facts(), wholesale).map((b) => b.key), ["stock"]);
  assert.equal(readyForDelivery(facts({ stock: [{ pdiStatus: "not_started" }] }), wholesale), true, "an uninspected unit is fine where there is no inspection");
});

test("a switched-off module never asks for its step", () => {
  const noStock = lifecycleFor("automotive", new Set(["automotive"]));
  assert.ok(!noStock.steps.includes("stock"));
  const noWorkshop = lifecycleFor("automotive", new Set(["commerce"]));
  assert.ok(!noWorkshop.steps.includes("pdi"));
  assert.ok(noWorkshop.steps.includes("stock"));
  assert.deepEqual(dealBlockers(facts(), lifecycleFor("automotive", new Set())).map((b) => b.key), []);
});

test("every template's labels cover every step; the owner chooses, audited, per workspace", () => {
  for (const t of Object.values(LIFECYCLE_TEMPLATES)) for (const step of t.lifecycle.steps) assert.ok(t.lifecycle.labels[step]);
  const action = readFileSync("src/app/actions/dealLifecycle.ts", "utf8");
  assert.match(action, /requireTenantOwner\(\)/);
  assert.match(action, /putWorkspaceSetting\(tenantId, DEAL_LIFECYCLE_KEY, template\)/);
  assert.match(action, /logAudit\(/);
  assert.match(readFileSync("src/lib/dealLifecycleServer.ts", "utf8"), /getWorkspaceSetting\(await actingTenantId\(\), DEAL_LIFECYCLE_KEY\)/);
  // Both screens read the workspace's lifecycle.
  assert.match(readFileSync("src/lib/dealsCentre.ts", "utf8"), /lifecycle: await getDealLifecycle\(\)/);
  assert.match(readFileSync("src/app/(app)/deals/[id]/page.tsx", "utf8"), /const lifecycle = await getDealLifecycle\(\)/);
});

test("the readiness card speaks the lifecycle: its names, its steps, and 'not needed' for a deposit nobody asked", () => {
  const expected = {
    automotive: ["Ready for delivery?", "Accepted", "Deposit received", "Delivery booked"],
    services: ["Ready for completion?", "Engagement", "Retainer received", "Completion booked"],
    wholesale: ["Ready for dispatch?", "Order confirmed", "Payment received", "Dispatch booked"],
    property: ["Ready for handover?", "Offer accepted", "Deposit received", "Handover booked"],
  } as const;
  for (const [key, words] of Object.entries(expected)) {
    const lifecycle = lifecycleFor(key as keyof typeof expected, ALL);
    const ready = readinessLabels(lifecycle);
    assert.deepEqual([ready.title, ready.accepted, ready.deposit, ready.delivery], [...words], key);
    // With a deposit asked and unpaid: a step to do and a blocker. With none asked: skipped, no blocker.
    const owed = dealMilestones(facts({ depositPaid: false }), lifecycle).find((s) => s.key === "deposit")!;
    assert.deepEqual([owed.done, owed.skipped], [false, false], key);
    assert.ok(dealBlockers(facts({ depositPaid: false }), lifecycle).some((b) => b.key === "deposit"), key);
    const none = dealMilestones(facts({ depositCents: 0, depositPaid: false }), lifecycle).find((s) => s.key === "deposit")!;
    assert.equal(none.skipped, true, key);
    assert.ok(!dealBlockers(facts({ depositCents: 0, depositPaid: false }), lifecycle).some((b) => b.key === "deposit"), key);
  }
  const page = readFileSync("src/app/(app)/deals/[id]/page.tsx", "utf8");
  assert.match(page, /\{ready\.title\}/);
  assert.match(page, /skipped=\{depositStep\.skipped\} label=\{ready\.deposit\}/);
  assert.match(page, /label=\{ready\.delivery\}/);
  // No fixed vehicle words left on the card.
  assert.doesNotMatch(page, /Ready to deliver\?|"Agreement accepted"|label="Deposit received"|label="Delivery booked"|No deposit receipt recorded/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { AUTOMOTIVE_LIFECYCLE, dealMilestones, type DealFacts } from "../src/lib/dealMilestones";
import { dealStand, nextStepWarning, type StandFacts } from "../src/lib/dealStand";

/** The deal page's one account of where a deal stands (wave 2, W2-05). */
const date = (d: Date) => d.toISOString().slice(0, 10);
const base: DealFacts = { accepted: false, depositCents: 0, depositPaid: false, stock: [], deliveryBooked: false, delivered: false };
const stand = (deal: Partial<DealFacts>, over: Partial<StandFacts> = {}) => {
  const facts = { ...base, ...deal };
  return dealStand({
    journey: dealMilestones(facts, AUTOMOTIVE_LIFECYCLE),
    status: facts.accepted ? "accepted" : "sent",
    accepted: facts.accepted,
    delivered: facts.delivered,
    financeHolds: Boolean(facts.financeHolds),
    sentAt: new Date("2026-11-23T10:00:00Z"),
    viewedAt: null,
    signedAt: null,
    depositPaid: facts.depositPaid,
    depositLabel: facts.depositCents ? "R 5 000,00" : null,
    stockCount: facts.stock.length,
    pdiReady: false,
    deliveryAt: null,
    deliveredAt: null,
    customer: "The customer",
    readyTitle: "Ready for delivery?",
    date,
    ...over,
  });
};
const states = (s: ReturnType<typeof stand>) => s.steps.map((step) => `${step.key}:${step.state}`).join(" ");

test("a sent quote: waiting on the customer; the deposit nobody asked for is not needed; stock is next", () => {
  const s = stand({});
  assert.equal(states(s), "quote:done accepted:now deposit:skipped stock:next pdi:later delivery:later");
  const accepted = s.steps.find((step) => step.key === "accepted")!;
  assert.equal(accepted.detail, "The customer to accept · not opened yet");
  assert.equal(accepted.who, "Customer");
  assert.equal(accepted.action, "accept");
  assert.deepEqual(s.headline, { text: "Waiting for the customer to accept", tone: "warning", detail: "Sent 2026-11-23 · not opened yet" });
  // Opened: said so, with the date the CRM keeps (the first open).
  assert.match(stand({}, { viewedAt: new Date("2026-11-24T08:00:00Z") }).steps[1].detail, /opened 2026-11-24/);
});

test("a draft is on the quote step itself, not 'Accepted'", () => {
  const s = stand({}, { status: "draft", sentAt: null });
  assert.equal(states(s), "quote:now accepted:next deposit:skipped stock:later pdi:later delivery:later");
  assert.equal(s.headline.text, "Draft — not sent to the customer yet");
  assert.equal(s.steps[1].action, null, "nothing to chase before it is sent");
});

test("accepted with a deposit asked: the deposit is now, with its amount; deposit and delivery buttons only once accepted", () => {
  const s = stand({ accepted: true, depositCents: 500000 });
  assert.equal(states(s), "quote:done accepted:done deposit:now stock:next pdi:later delivery:later");
  assert.equal(s.steps[2].detail, "R 5 000,00 expected");
  assert.equal(s.steps[2].action, "deposit");
  assert.equal(s.headline.text, "Accepted · next: deposit");
  assert.equal(stand({ depositCents: 500000 }).steps[2].action, null, "no deposit to record before acceptance");
});

test("finance holding delivery is the headline; a finished deal says ready; delivered says delivered", () => {
  assert.equal(stand({ accepted: true, financeHolds: true }).headline.text, "Finance not approved — delivery is held");
  const ready = stand({ accepted: true, stock: [{ pdiStatus: "passed" }], deliveryBooked: true });
  assert.equal(ready.steps.find((s) => s.key === "delivery")!.state, "now", "booked is not delivered");
  const done = stand({ accepted: true, delivered: true }, { deliveredAt: new Date("2026-12-01T10:00:00Z") });
  assert.equal(done.steps.every((s) => s.state === "done"), true);
  assert.deepEqual(done.headline, { text: "Delivered 2026-12-01", tone: "success", detail: null });
});

test("declined and cancelled deals are over: no step is now or next, and nothing to chase or do", () => {
  for (const status of ["declined", "cancelled"]) {
    const s = stand({}, { status });
    assert.equal(states(s), "quote:done accepted:later deposit:skipped stock:later pdi:later delivery:later", status);
    assert.equal(s.steps.every((step) => step.action === null && step.who === null), true, status);
    assert.deepEqual(s.holds, []);
    assert.match(s.headline.text, status === "declined" ? /^Declined/ : /^Cancelled/);
  }
  // A sent and an accepted deal still work.
  assert.equal(stand({}).steps[1].action, "accept");
  assert.equal(stand({ accepted: true }).steps.find((step) => step.state === "now")!.action, "stock");
});

test("finance holding an accepted deal is on the panel as a hold with its own button, beside the steps", () => {
  const held = stand({ accepted: true, stock: [{ pdiStatus: "passed" }], deliveryBooked: true, financeHolds: true });
  assert.deepEqual(held.holds, [{ key: "finance", label: "Finance", detail: "Not approved yet — delivery waits for it", who: "Finance house", action: "finance" }]);
  assert.equal(held.steps.find((step) => step.key === "delivery")!.state, "now", "the steps still say where it is");
  assert.deepEqual(stand({ accepted: true }).holds, [], "no hold when finance is fine");
  assert.deepEqual(stand({ financeHolds: true }).holds, [], "not before acceptance");
  assert.deepEqual(stand({ accepted: true, delivered: true, financeHolds: true }).holds, [], "not once delivered");
});

test("the next-step warning: none planned, overdue, or after the quote expires while unaccepted", () => {
  const now = new Date("2026-11-24T10:00:00Z");
  const w = (over: Partial<Parameters<typeof nextStepWarning>[0]>) =>
    nextStepWarning({ nextDue: new Date("2026-11-26T09:00:00Z"), validUntil: new Date("2026-12-07T00:00:00Z"), accepted: false, delivered: false, closed: false, now, date, ...over });
  assert.equal(w({}), null);
  assert.equal(w({ nextDue: null }), "No next step planned on this deal.");
  assert.equal(w({ nextDue: new Date("2026-11-20T09:00:00Z") }), "This is overdue.");
  assert.match(w({ nextDue: new Date("2027-01-11T09:00:00Z") })!, /after the quote's valid-until date \(2026-12-07\)/);
  assert.equal(w({ nextDue: new Date("2027-01-11T09:00:00Z"), accepted: true }), null, "an accepted quote no longer expires");
  assert.equal(w({ nextDue: null, delivered: true }), null);
  assert.equal(w({ nextDue: null, closed: true }), null);
});

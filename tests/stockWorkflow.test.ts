import test from "node:test";
import assert from "node:assert/strict";

const transitions: Record<string, readonly string[]> = {
  incoming: ["received_pending_check", "hold", "damaged"],
  received_pending_check: ["available", "hold", "damaged"],
  available: ["reserved", "allocated", "hold", "damaged"],
  reserved: ["available", "allocated", "hold"],
  allocated: ["available", "pdi", "hold"],
  pdi: ["allocated", "ready_for_delivery", "hold", "damaged"],
  ready_for_delivery: ["pdi", "delivered", "hold"],
  delivered: [],
  hold: ["available", "allocated", "pdi", "damaged"],
  damaged: ["hold", "available"],
  sold: ["delivered"],
};

const canTransition = (from: string, to: string) => transitions[from]?.includes(to) ?? false;

test("stock follows receiving and inspection before availability", () => {
  assert.equal(canTransition("incoming", "available"), false);
  assert.equal(canTransition("incoming", "received_pending_check"), true);
  assert.equal(canTransition("received_pending_check", "available"), true);
});

test("reserved stock can allocate or release but cannot jump to delivery", () => {
  assert.equal(canTransition("reserved", "allocated"), true);
  assert.equal(canTransition("reserved", "available"), true);
  assert.equal(canTransition("reserved", "ready_for_delivery"), false);
  assert.equal(canTransition("reserved", "delivered"), false);
});

test("allocated stock must complete PDI before delivery", () => {
  assert.equal(canTransition("allocated", "pdi"), true);
  assert.equal(canTransition("allocated", "ready_for_delivery"), false);
  assert.equal(canTransition("pdi", "ready_for_delivery"), true);
  assert.equal(canTransition("ready_for_delivery", "delivered"), true);
});

test("delivered stock is terminal", () => {
  assert.deepEqual(transitions.delivered, []);
  assert.equal(canTransition("delivered", "available"), false);
});

test("hold and damaged states require controlled recovery", () => {
  assert.equal(canTransition("hold", "available"), true);
  assert.equal(canTransition("hold", "pdi"), true);
  assert.equal(canTransition("damaged", "hold"), true);
  assert.equal(canTransition("damaged", "delivered"), false);
});

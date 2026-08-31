import assert from "node:assert/strict";
import test from "node:test";
import { handoffContext } from "../src/lib/botHandoff";

test("handoff context reads flat WhatsApp metadata and SLA", () => {
  const requestedAt = new Date("2026-01-01T10:00:00Z");
  const context = handoffContext(JSON.stringify({
    __handoff_reason: "Customer asked for a person",
    __handoff_summary: "Needs a quote",
    __handoff_confidence: "0.42",
  }), requestedAt, new Date("2026-01-01T10:16:00Z"));
  assert.equal(context.reason, "Customer asked for a person");
  assert.equal(context.summary, "Needs a quote");
  assert.equal(context.confidence, 0.42);
  assert.equal(context.dueAt.toISOString(), "2026-01-01T10:15:00.000Z");
  assert.equal(context.overdue, true);
});

test("handoff context reads packed DM vars and survives malformed state", () => {
  const requestedAt = new Date("2026-01-01T10:00:00Z");
  assert.equal(handoffContext(JSON.stringify({ v: { __handoff_intent: "booking" } }), requestedAt).intent, "booking");
  assert.equal(handoffContext("not-json", requestedAt).reason, null);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { runFlow, type Flow, type FlowCtx } from "../src/lib/flow";
import { flowTemplate } from "../src/lib/flowTemplates";
import { validateFlow } from "../src/lib/flowValidation";

/**
 * A CRM action that FAILED must never reach a node that tells the customer it
 * worked.
 *
 * Every side-effecting node used to send its text and advance to `next`
 * regardless of outcome. So the shipped cancellation node said "Done — your
 * booking has been cancelled" for a cancellation that did not happen, a slots
 * node with nothing available walked into "You're booked, {{name}}!", and a
 * reservation lost to a race did the same. Being told an action succeeded when it
 * did not is worse than an error, because the customer acts on it.
 */

const baseCtx: FlowCtx = {
  aiReply: async () => ({ reply: "AI", handoff: false }),
  dynamicAnswer: async () => "",
  createBooking: async () => {},
  handoff: async () => {},
};

async function run(flow: Flow, ctx: Partial<FlowCtx>, choiceId?: string, at: string | null = null) {
  // `at` matters for slot selection: the engine only processes a tap when the
  // session is already waiting AT that node, exactly as it is in production.
  return runFlow(flow, { nodeId: at, vars: {} }, { text: "", ...(choiceId ? { choiceId } : {}) }, { ...baseCtx, ...ctx });
}

const cancelFlow: Flow = {
  start: "cancel",
  nodes: {
    cancel: {
      id: "cancel", type: "booking", action: "cancel",
      text: "Done — your booking has been cancelled.",
      failureText: "I couldn't cancel that.",
      next: "ok", failureNext: "bad",
    },
    ok: { id: "ok", type: "message", text: "See you next time.", next: "end" },
    bad: { id: "bad", type: "message", text: "The team will call you.", next: "end" },
    end: { id: "end", type: "end" },
  },
};

test("a failed cancellation never claims the booking was cancelled", async () => {
  const failed = await run(cancelFlow, { manageBooking: async () => ({ ok: false }) });
  const said = failed.messages.map((m) => (m.type === "text" ? m.text : "")).join(" ");
  assert.doesNotMatch(said, /has been cancelled/, "the customer must not be told it worked");
  assert.match(said, /couldn't cancel/);
  assert.match(said, /team will call you/, "and must land on the failure route");

  const worked = await run(cancelFlow, { manageBooking: async () => ({ ok: true }) });
  const good = worked.messages.map((m) => (m.type === "text" ? m.text : "")).join(" ");
  assert.match(good, /has been cancelled/);
  assert.match(good, /See you next time/);
});

test("a Journey that refused to start does not report that it started", async () => {
  const flow: Flow = {
    start: "j",
    nodes: {
      j: { id: "j", type: "journey", journeyId: "x", text: "You're enrolled.", failureText: "I couldn't enrol you.", next: "ok", failureNext: "bad" },
      ok: { id: "ok", type: "message", text: "Welcome aboard.", next: "end" },
      bad: { id: "bad", type: "message", text: "A person will follow up.", next: "end" },
      end: { id: "end", type: "end" },
    },
  };
  const failed = await run(flow, { startJourney: async () => ({ ok: false, reason: "inactive" }) });
  const said = failed.messages.map((m) => (m.type === "text" ? m.text : "")).join(" ");
  assert.doesNotMatch(said, /enrolled|Welcome aboard/);
  assert.match(said, /follow up/);
});

test("no available slots does not walk into the booked-confirmation node", async () => {
  const flow: Flow = {
    start: "s",
    nodes: {
      s: { id: "s", type: "slots", action: "book", text: "Pick a time:", noneText: "Nothing open online.", next: "confirm", failureNext: "bad" },
      confirm: { id: "confirm", type: "message", text: "You're booked!", next: "end" },
      bad: { id: "bad", type: "message", text: "The team will call you to book.", next: "end" },
      end: { id: "end", type: "end" },
    },
  };
  const out = await run(flow, { availableSlots: async () => [] });
  const said = out.messages.map((m) => (m.type === "text" ? m.text : "")).join(" ");
  assert.doesNotMatch(said, /You're booked/, "nothing was booked, so nothing may say it was");
  assert.match(said, /Nothing open online/);
  assert.match(said, /team will call you/);
});

test("a slot lost to a race, with no alternatives, does not confirm a booking", async () => {
  const flow: Flow = {
    start: "s",
    nodes: {
      s: { id: "s", type: "slots", action: "book", text: "Pick a time:", next: "confirm", failureNext: "bad" },
      confirm: { id: "confirm", type: "message", text: "You're booked!", next: "end" },
      bad: { id: "bad", type: "message", text: "That time went — the team will call you.", next: "end" },
      end: { id: "end", type: "end" },
    },
  };
  const out = await run(
    flow,
    {
      // The customer taps a time that someone else took, and nothing is left.
      availableSlots: async () => [],
      bookSlot: async () => ({ ok: false }),
    },
    "s|2030-01-15_09:00",
    "s",
  );
  const said = out.messages.map((m) => (m.type === "text" ? m.text : "")).join(" ");
  assert.doesNotMatch(said, /You're booked/);
  assert.match(said, /the team will call you/i);
});

test("the compiler warns when a failing action feeds a node that speaks", () => {
  const unsafe: Flow = {
    start: "cancel",
    nodes: {
      cancel: { id: "cancel", type: "booking", action: "cancel", text: "Cancelling…", next: "confirm" },
      confirm: { id: "confirm", type: "message", text: "Done — your booking has been cancelled.", next: "end" },
      end: { id: "end", type: "end" },
    },
  };
  const codes = validateFlow(unsafe, ["whatsapp"]).map((i) => i.code);
  assert.ok(codes.includes("action.no_failure_branch"), `expected the warning, got ${codes.join(", ")}`);
});

test("every shipped template survives its own compiler", () => {
  for (const id of ["general", "sales", "service", "lead_capture", "booking_management"] as const) {
    const flow = flowTemplate(id).definition;
    const unsafe = validateFlow(flow, ["whatsapp"]).filter((i) => i.code === "action.no_failure_branch");
    assert.deepEqual(unsafe, [], `${id} can report a failed action as a success: ${unsafe.map((i) => i.nodeId).join(", ")}`);
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runFlow, type Flow, type FlowCtx } from "../src/lib/flow";
import { flowTemplate } from "../src/lib/flowTemplates";
import { flowErrors, publishSeverity, validateFlow } from "../src/lib/flowValidation";

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
  createBooking: async () => ({ ok: true }),
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

test("publication REFUSES a graph whose failing action feeds a node that speaks", () => {
  const unsafe: Flow = {
    start: "cancel",
    nodes: {
      cancel: { id: "cancel", type: "booking", action: "cancel", text: "Cancelling…", next: "confirm" },
      confirm: { id: "confirm", type: "message", text: "Done — your booking has been cancelled.", next: "end" },
      end: { id: "end", type: "end" },
    },
  };
  // Editing stays permissive so an existing draft still opens…
  const editing = validateFlow(unsafe, ["whatsapp"]).find((i) => i.code === "action.no_failure_branch");
  assert.ok(editing, "the editor must still surface it");
  assert.equal(editing.severity, "warning", "an old draft must remain openable");

  // …but publishing is the migration boundary, and it refuses.
  const onPublish = publishSeverity(validateFlow(unsafe, ["whatsapp"])).find((i) => i.code === "action.no_failure_branch");
  assert.ok(onPublish, "publication must see it too");
  assert.equal(onPublish.severity, "error", "a NEW publication may not ship a false-success path");
  assert.ok(flowErrors(publishSeverity(validateFlow(unsafe, ["whatsapp"]))).length > 0, "and that must block publish");
  // …and the server publish path must actually apply that grading.
  assert.match(readFileSync(new URL("../src/lib/flowValidationServer.ts", import.meta.url), "utf8"), /publishSeverity\(issues\)/);
});

test("a demo request with no pipeline cannot tell the customer it was submitted", async () => {
  // The regression the reviewer asked for by name. createBooking used to return
  // void, so the engine assumed success: createLeadRecordIfPipelineReady returns
  // null when no pipeline stage exists, createDemo returned silently, and the
  // Sales flow still said "I've sent your demo request to the team".
  const flow: Flow = {
    start: "demo",
    nodes: {
      demo: {
        id: "demo", type: "booking", action: "demo",
        text: "I've sent your demo request to the team.",
        failureText: "I couldn't log that just yet — a person will pick it up.",
        next: "end", failureNext: "handoff",
      },
      handoff: { id: "handoff", type: "handoff", text: "One of the team will call you." },
      end: { id: "end", type: "end" },
    },
  };
  const out = await run(flow, {
    createBooking: async () => ({ ok: false, reason: "No pipeline stage is configured to receive the request" }),
  });
  const said = out.messages.map((m) => (m.type === "text" ? m.text : "")).join(" ");
  assert.doesNotMatch(said, /sent your demo request/, "nothing was created, so nothing may say it was");
  assert.match(said, /couldn't log that/);
  assert.equal(out.handedOff, true, "and it must reach a person");
});

test("a lookup that finds nothing drives the route, not just a variable", async () => {
  // The engine used to keep the lookup outcome only for `cancel`, so a lookup that
  // refused an unidentified customer still continued down the success branch and
  // relied on later condition nodes to catch it.
  const flow: Flow = {
    start: "lookup",
    nodes: {
      lookup: { id: "lookup", type: "booking", action: "lookup", next: "found", failureNext: "none" },
      found: { id: "found", type: "message", text: "I found your booking.", next: "end" },
      none: { id: "none", type: "message", text: "I couldn't find one.", next: "end" },
      end: { id: "end", type: "end" },
    },
  };
  const out = await run(flow, { manageBooking: async () => ({ ok: false }) });
  const said = out.messages.map((m) => (m.type === "text" ? m.text : "")).join(" ");
  assert.doesNotMatch(said, /I found your booking/);
  assert.match(said, /couldn't find one/);
});

test("a failure with no route defined ends the turn rather than claiming success", async () => {
  const flow: Flow = {
    start: "cancel",
    nodes: {
      cancel: { id: "cancel", type: "booking", action: "cancel", text: "Done — cancelled.", next: "confirm" },
      confirm: { id: "confirm", type: "message", text: "You're all set.", next: "end" },
      end: { id: "end", type: "end" },
    },
  };
  const out = await run(flow, { manageBooking: async () => ({ ok: false }) });
  const said = out.messages.map((m) => (m.type === "text" ? m.text : "")).join(" ");
  assert.doesNotMatch(said, /Done — cancelled|You're all set/, "silence beats a false confirmation");
});

test("no capacity and a failed reservation are different states", async () => {
  const flow: Flow = {
    start: "s",
    nodes: {
      s: { id: "s", type: "slots", action: "book", text: "Pick a time:", noneText: "Nothing open online.", next: "confirm", unavailableNext: "callback", failureNext: "sorry" },
      confirm: { id: "confirm", type: "message", text: "You're booked!", next: "end" },
      callback: { id: "callback", type: "message", text: "We'll call you to find a time.", next: "end" },
      sorry: { id: "sorry", type: "message", text: "That went wrong — a person will help.", next: "end" },
      end: { id: "end", type: "end" },
    },
  };
  const none = await run(flow, { availableSlots: async () => [] });
  const noneSaid = none.messages.map((m) => (m.type === "text" ? m.text : "")).join(" ");
  assert.match(noneSaid, /call you to find a time/, "no capacity is a valid request we cannot meet");
  assert.doesNotMatch(noneSaid, /went wrong/);

  const lost = await run(flow, { availableSlots: async () => [], bookSlot: async () => ({ ok: false }) }, "s|2030-01-15_09:00", "s");
  const lostSaid = lost.messages.map((m) => (m.type === "text" ? m.text : "")).join(" ");
  assert.match(lostSaid, /went wrong/, "a failed reservation is a failure, not mere unavailability");
});

test("every shipped template survives its own PUBLISH compiler", () => {
  for (const id of ["general", "sales", "service", "lead_capture", "booking_management"] as const) {
    const issues = flowErrors(publishSeverity(validateFlow(flowTemplate(id).definition, ["whatsapp", "messenger", "instagram", "telegram"])));
    assert.deepEqual(issues, [], `${id} would be refused at publish: ${issues.map((i) => `${i.nodeId}:${i.code}`).join(", ")}`);
  }
});

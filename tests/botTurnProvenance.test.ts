/**
 * A turn must not lose its own output.
 *
 * Two ways it did:
 *
 *  A. `runFlow` works on a COPY of the caller's variables and used to hand that
 *     copy back only inside `result.session`. `session` is null on handoff and
 *     when the graph ends, so on exactly those paths everything the turn produced
 *     was dropped — the answer the customer had just given, the `booking_id` a
 *     CRM action had just written, `journey_run_id`, the `__handoff_*` context.
 *     The person picking up the handover saw the state from before the last
 *     message. That is the state the SIMULATOR showed an author, too.
 *
 *  B. An outbound message carried no origin node, so a delivery failure could be
 *     attributed to a flow version but never to a node.
 *
 * Both are executed here against the real engine — no source scanning — and the
 * persistence half of A is executed against the real shared decision the two
 * runners now use (`sessionAfterTurn`), because that is where the asymmetry was.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { runFlow, type Flow, type FlowCtx, type OutMsg } from "../src/lib/flow";
import { sessionAfterTurn } from "../src/lib/flowTurnState";

const baseCtx: FlowCtx = {
  aiReply: async () => ({ reply: "AI", handoff: false }),
  dynamicAnswer: async () => "dynamic",
  createBooking: async () => {},
  handoff: async () => {},
};

const textOf = (message: OutMsg | undefined) => (message?.type === "text" ? message.text : "");

test("a CRM action's variables survive the handoff that ends the same turn", async () => {
  // The real shape: look the customer's booking up, then hand the conversation to
  // a person so they can deal with it. What the lookup wrote is the ONLY reason
  // the handover is useful.
  const flow: Flow = {
    start: "lookup",
    nodes: {
      lookup: { id: "lookup", type: "booking", action: "lookup", next: "toHuman" },
      toHuman: { id: "toHuman", type: "handoff", text: "Putting you through to the team now." },
    },
  };
  const startVars: Record<string, string> = { name: "Thabo" };
  const result = await runFlow(flow, { nodeId: null, vars: startVars }, { text: "" }, {
    ...baseCtx,
    manageBooking: async (_action, vars) => {
      vars.booking_found = "yes";
      vars.booking_id = "activity-77";
      vars.booking_slot = "Tue 15 Jan · 09:00";
      return { ok: true };
    },
  });

  assert.equal(result.session, null, "a handoff leaves no graph position");
  assert.equal(result.handedOff, true);
  assert.equal(result.vars.booking_id, "activity-77", "the handover must carry the booking the turn just found");
  assert.equal(result.vars.booking_slot, "Tue 15 Jan · 09:00");
  assert.equal(result.vars.name, "Thabo", "and everything the conversation already knew");

  // The engine deliberately does not write through to the caller's object, so
  // `result.vars` is the only way these values can be persisted. This is exactly
  // why reading them off the pre-turn object lost them.
  assert.equal(startVars.booking_id, undefined, "runFlow must keep working on a copy");
});

test("what the customer just typed survives the handoff it triggered", async () => {
  const flow: Flow = {
    start: "askPhone",
    nodes: {
      askPhone: { id: "askPhone", type: "capture", text: "What's the best number for you?", variable: "phone", format: "phone", next: "toHuman" },
      toHuman: { id: "toHuman", type: "handoff", text: "Thanks — one of the team will call you." },
    },
  };

  const first = await runFlow(flow, { nodeId: null, vars: {} }, { text: "" }, baseCtx);
  assert.equal(first.session?.nodeId, "askPhone", "the first turn stops on the capture");

  const answered = await runFlow(flow, { nodeId: "askPhone", vars: first.vars }, { text: "0821234567" }, baseCtx);
  assert.equal(answered.handedOff, true);
  assert.equal(
    answered.vars.phone,
    "0821234567",
    "the number the customer supplied on the final turn is the whole point of the handover",
  );
});

test("a flow that ends still reports what its last nodes produced", async () => {
  const flow: Flow = {
    start: "enrol",
    nodes: {
      enrol: { id: "enrol", type: "journey", journeyId: "service-reminder", text: "You're on the list.", next: "end" },
      end: { id: "end", type: "end" },
    },
  };
  const result = await runFlow(flow, { nodeId: null, vars: {} }, { text: "" }, {
    ...baseCtx,
    startJourney: async (_journeyId, vars) => {
      vars.journey_run_id = "run-9";
      return { ok: true, reason: "enrolled" };
    },
  });

  assert.equal(result.session, null, "the graph ran to its end node");
  assert.equal(result.handedOff, false);
  assert.equal(result.vars.journey_run_id, "run-9");
  assert.equal(result.vars.journey_started, "yes");
});

test("AI handoff context is carried out of the turn that decided to hand off", async () => {
  const flow: Flow = { start: "chat", nodes: { chat: { id: "chat", type: "ai" } } };
  let handedTo: Record<string, string> | null = null;
  const result = await runFlow(flow, { nodeId: null, vars: {} }, { text: "this is a warranty dispute" }, {
    ...baseCtx,
    aiReply: async () => ({
      reply: "Let me get someone on this.",
      handoff: true,
      confidence: "low",
      intent: "warranty_dispute",
      handoffReason: "out of scope",
      handoffSummary: "Customer disputes a warranty decision",
    }),
    handoff: async (vars) => { handedTo = { ...vars }; },
  });

  assert.equal(result.handedOff, true);
  assert.equal(result.vars.__handoff_intent, "warranty_dispute");
  assert.equal(result.vars.__handoff_summary, "Customer disputes a warranty decision");
  assert.equal(result.vars.__handoff_reason, "out of scope");
  assert.ok(handedTo, "the notification hook still receives the live variables");
});

test("every outcome persists the variables the turn ended with, not the ones it started with", async () => {
  // The two runners used to write this branch out by hand and disagreed: the
  // waiting branch stored the turn's vars, the handoff branch stored the pre-turn
  // vars. They share one decision now, so this proves all three outcomes at once.
  const flow: Flow = {
    start: "lookup",
    nodes: {
      lookup: { id: "lookup", type: "booking", action: "lookup", next: "confirm" },
      confirm: { id: "confirm", type: "choice", text: "Found {{booking_slot}} — what next?", options: [
        { id: "human", label: "Talk to someone", next: "toHuman" },
        { id: "done", label: "Nothing thanks", next: "end" },
      ] },
      toHuman: { id: "toHuman", type: "handoff", text: "Putting you through." },
      end: { id: "end", type: "end" },
    },
  };
  const ctx: FlowCtx = {
    ...baseCtx,
    manageBooking: async (_action, vars) => {
      vars.booking_id = "activity-77";
      vars.booking_slot = "Tue 15 Jan · 09:00";
      return { ok: true };
    },
  };

  const waiting = await runFlow(flow, { nodeId: null, vars: {} }, { text: "" }, ctx);
  const afterWaiting = sessionAfterTurn(waiting);
  assert.equal(afterWaiting.keep, true);
  assert.equal(afterWaiting.keep && afterWaiting.nodeId, "confirm");
  assert.equal(afterWaiting.keep && afterWaiting.vars.booking_id, "activity-77");
  assert.equal(afterWaiting.keep && afterWaiting.ownership, "bot");

  // Resume from the stored position with the STORED variables, the way both
  // runners do, and choose the option that hands over.
  const stored = afterWaiting.keep ? afterWaiting.vars : {};
  const handedOff = await runFlow(flow, { nodeId: "confirm", vars: stored }, { text: "", choiceId: "confirm|human" }, ctx);
  const afterHandoff = sessionAfterTurn(handedOff);
  assert.equal(afterHandoff.keep, true, "a handoff keeps the session so staff can see it and 'menu' can escape it");
  assert.equal(afterHandoff.keep && afterHandoff.nodeId, null, "but there is no graph position to resume");
  assert.equal(afterHandoff.keep && afterHandoff.ownership, "ai_handoff");
  assert.equal(
    afterHandoff.keep && afterHandoff.vars.booking_id,
    "activity-77",
    "the booking the conversation resolved must reach the person taking it over",
  );

  const ended = await runFlow(flow, { nodeId: "confirm", vars: stored }, { text: "", choiceId: "confirm|done" }, ctx);
  assert.deepEqual(sessionAfterTurn(ended), { keep: false }, "a finished flow leaves nothing to resume");
});

test("every outbound message names the node that produced it", async () => {
  const flow: Flow = {
    start: "hello",
    nodes: {
      hello: { id: "hello", type: "message", text: "Hi there", next: "photo" },
      photo: { id: "photo", type: "image", url: "https://example.test/cart.jpg", caption: "The Rover XL", next: "menu" },
      menu: { id: "menu", type: "choice", text: "What next?", options: [{ id: "a", label: "Prices", next: "end" }] },
      end: { id: "end", type: "end" },
    },
  };
  const result = await runFlow(flow, { nodeId: null, vars: {} }, { text: "" }, baseCtx);

  assert.deepEqual(
    result.messages.map((message) => message.nodeId),
    ["hello", "photo", "menu"],
    "a delivery failure has to be attributable to the node whose message died",
  );
});

test("prompts, dynamic answers and empty-slot fallbacks are attributed too", async () => {
  const flow: Flow = {
    start: "prices",
    nodes: {
      prices: { id: "prices", type: "answer", answerSource: "pricelist", next: "slot" },
      slot: { id: "slot", type: "slots", action: "book", text: "Pick a time", noneText: "Nothing open — we'll call you.", next: "askName" },
      askName: { id: "askName", type: "capture", text: "What's your name?", variable: "name", next: "end" },
      end: { id: "end", type: "end" },
    },
  };
  const result = await runFlow(flow, { nodeId: null, vars: {} }, { text: "" }, {
    ...baseCtx,
    dynamicAnswer: async () => "Our current range…",
    availableSlots: async () => [],
  });

  assert.deepEqual(result.messages.map((message) => message.nodeId), ["prices", "slot", "askName"]);
  assert.equal(textOf(result.messages[1]), "Nothing open — we'll call you.");
  assert.equal(result.session?.nodeId, "askName");
});

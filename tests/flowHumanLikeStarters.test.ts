import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_FLOW, runFlow, type Flow, type FlowCtx, type FlowInput, type FlowResult, type FlowSession } from "../src/lib/flow";
import { FLOW_TEMPLATES, flowTemplate } from "../src/lib/flowTemplates";
import { flowErrors, publishSeverity, validateFlow } from "../src/lib/flowValidation";
import { nextSteps } from "../src/lib/flowLayout";
import { insertFlowSnippet } from "../src/lib/flowSnippetDefinition";

/**
 * THE STARTERS TALK LIKE A PERSON (2026-11-10).
 *
 * Each of these was a way the shipped flows sounded like a form: a typed question at a menu got the same menu back, a
 * returning customer was asked who they were, "talk to someone" promised a reply at midnight, details went to the team
 * unread-back, and a hand-off told staff nothing about why. The tests hold the conversations, not the wording.
 */

const code = (path: string) => readFileSync(path, "utf8");
const said = (r: FlowResult) => r.messages.map((m) => ("text" in m ? m.text : "")).join("\n");

type Calls = { handoffs: { reason?: string; summary?: string }[]; bookings: { action?: string; vars: Record<string, string> }[]; slots: string[]; tags: string[] };
function harness(over: Partial<FlowCtx> = {}) {
  const calls: Calls = { handoffs: [], bookings: [], slots: [], tags: [] };
  const ctx: FlowCtx = {
    aiReply: async () => ({ reply: "AI ANSWER", handoff: false }),
    dynamicAnswer: async () => "PRICE LIST",
    createBooking: async (vars, action) => { calls.bookings.push({ action, vars: { ...vars } }); return { ok: true }; },
    handoff: async (_vars, context) => { calls.handoffs.push({ reason: context?.reason, summary: context?.summary }); },
    availableSlots: async () => [{ id: "2030-01-15_09:00", label: "Tue 15 Jan · 09:00" }],
    bookSlot: async (slotId) => { calls.slots.push(slotId); return { ok: true, label: "Tue 15 Jan · 09:00" }; },
    updateCrm: async (node) => { calls.tags.push(node.tagName ?? ""); return { ok: true }; },
    openNow: async () => true,
    ...over,
  };
  return { ctx, calls };
}

/** Walk a conversation: each entry is what the customer sends next. Returns every turn's result. */
async function talk(flow: Flow, ctx: FlowCtx, turns: (string | FlowInput)[], vars: Record<string, string> = { greeting: "Hi there 👋" }) {
  let session: FlowSession = { nodeId: null, vars };
  const results: FlowResult[] = [];
  for (const turn of turns) {
    const input = typeof turn === "string" ? { text: turn } : turn;
    const result = await runFlow(flow, session, input, ctx);
    results.push(result);
    if (!result.session) break;
    session = result.session;
  }
  return results;
}
const tap = (nodeId: string, optionId: string): FlowInput => ({ text: "", choiceId: `${nodeId}|${optionId}` });
const last = <T>(items: T[]) => items[items.length - 1];

// ── The engine: a typed reply at a menu ────────────────────────────────────────────────────────────────────────────

const menu: Flow = {
  start: "menu",
  nodes: {
    menu: { id: "menu", type: "choice", text: "What can I do for you?", elseNext: "ai", options: [{ id: "prices", label: "Prices", next: "prices" }, { id: "book", label: "Book a service", next: "book" }] },
    prices: { id: "prices", type: "message", text: "From R100" },
    book: { id: "book", type: "message", text: "Booking…" },
    ai: { id: "ai", type: "ai" },
  },
};

test("a typed question at a menu goes to the menu's 'anything else' step — not the same menu again", async () => {
  const { ctx } = harness();
  const [, answer] = await talk(menu, ctx, ["hi", "do you deliver to Durban?"]);
  assert.equal(said(answer), "AI ANSWER");
  assert.equal(answer.session?.nodeId, "ai", "the conversation carries on with the assistant");
});

test("…but a tap, a number or an option's own words still follow that option", async () => {
  const { ctx } = harness();
  assert.equal(said(last(await talk(menu, ctx, ["hi", tap("menu", "prices")]))), "From R100");
  assert.equal(said(last(await talk(menu, ctx, ["hi", "2"]))), "Booking…");
  assert.equal(said(last(await talk(menu, ctx, ["hi", "prices"]))), "From R100");
});

test("…and an empty message, a stale tap or a route that leads nowhere shows the menu again, as before", async () => {
  const { ctx } = harness();
  for (const input of [{ text: "   " }, { text: "", choiceId: "oldmenu|x" }] as FlowInput[]) {
    const again = last(await talk(menu, ctx, ["hi", input]));
    assert.equal(again.messages[0]?.type, "choice");
    assert.equal(again.session?.nodeId, "menu");
  }
  const unset: Flow = { ...menu, nodes: { ...menu.nodes, menu: { ...menu.nodes.menu, elseNext: "" } as Flow["nodes"][string] } };
  assert.equal(last(await talk(unset, ctx, ["hi", "do you deliver?"])).messages[0]?.type, "choice");
  const gone: Flow = { ...menu, nodes: { ...menu.nodes, menu: { ...menu.nodes.menu, elseNext: "deleted" } as Flow["nodes"][string] } };
  assert.equal(last(await talk(gone, ctx, ["hi", "do you deliver?"])).messages[0]?.type, "choice");
});

test("the 'anything else' route is a wire everywhere wires are counted", () => {
  // Validation: a missing target is refused, the target is reachable, an unset route is said out loud.
  const missing: Flow = { ...menu, nodes: { ...menu.nodes, menu: { ...menu.nodes.menu, elseNext: "nowhere" } as Flow["nodes"][string] } };
  assert.ok(flowErrors(validateFlow(missing)).some((issue) => issue.code === "graph.missing_target"));
  assert.ok(!validateFlow(menu).some((issue) => issue.code === "graph.unreachable" && issue.nodeId === "ai"));
  const unset: Flow = { ...menu, nodes: { ...menu.nodes, menu: { ...menu.nodes.menu, elseNext: "" } as Flow["nodes"][string] } };
  assert.ok(validateFlow(unset).some((issue) => issue.code === "choice.else_route" && issue.severity === "warning"));
  // Tidy layout, and a pasted block's new ids.
  assert.ok(nextSteps(menu.nodes.menu).includes("ai"));
  const pasted = insertFlowSnippet({ start: "s", nodes: { s: { id: "s", type: "end" } } }, menu, "blk");
  assert.equal((pasted.definition.nodes.blk_menu as { elseNext?: string }).elseNext, "blk_ai");
  // The builder: a dot on the step, a wire, a connection, a picker, and cleared when its target is deleted.
  const builder = code("src/components/FlowBuilder.tsx");
  assert.match(builder, /id="else"/);
  assert.match(builder, /add\("else", n\.elseNext/);
  assert.match(builder, /c\.sourceHandle === "else"\) return \{ \.\.\.n, elseNext: c\.target! \}/);
  assert.match(builder, /If they type something else/);
  assert.match(builder, /n\.elseNext === removedId\) n = \{ \.\.\.n, elseNext: "" \}/);
  assert.match(code("src/lib/flowVersionDiff.ts"), /"elseNext"/);
  assert.match(code("src/lib/flowAiNodes.ts"), /elseNext\?/);
});

test("a wrong answer is corrected the way a person would — not the question again with a bracket on the end", async () => {
  const flow: Flow = {
    start: "phone",
    nodes: {
      phone: { id: "phone", type: "capture", text: "What's the best number to reach you on?", variable: "phone", format: "phone", next: "email" },
      email: { id: "email", type: "capture", text: "And your email?", variable: "email", format: "email", next: "done" },
      done: { id: "done", type: "message", text: "Thanks" },
    },
  };
  const { ctx } = harness();
  const results = await talk(flow, ctx, ["hi", "call me maybe", "082 123 4567", "nope", "a@b.co"]);
  assert.match(said(results[1]), /doesn't look like a phone number/);
  assert.doesNotMatch(said(results[1]), /\(please enter/);
  assert.equal(results[1].session?.nodeId, "phone", "still waiting on the same question");
  assert.match(said(results[3]), /doesn't look like an email address/);
  assert.equal(said(results[4]), "Thanks");
});

// ── The starters ───────────────────────────────────────────────────────────────────────────────────────────────────

test("every starter survives the publish compiler on every channel — and none ships with a warning of its own", () => {
  assert.equal(new Set(FLOW_TEMPLATES.map((template) => template.id)).size, FLOW_TEMPLATES.length);
  for (const template of FLOW_TEMPLATES) {
    const issues = publishSeverity(validateFlow(template.definition, ["whatsapp", "messenger", "instagram", "telegram"]))
      // The QR pack leaves its two files for the owner to choose, and says so on Instagram/Telegram.
      .filter((issue) => issue.code !== "document.missing" && issue.code !== "channel.document_fallback");
    assert.deepEqual(issues, [], `${template.id}: ${issues.map((issue) => `${issue.nodeId}:${issue.code}`).join(", ")}`);
  }
});

test("every hand-off in a starter tells staff why", () => {
  for (const template of FLOW_TEMPLATES) {
    for (const node of Object.values(template.definition.nodes)) {
      if (node.type === "handoff") assert.ok(node.reason?.trim(), `${template.id}.${node.id} hands over without a reason`);
    }
  }
});

test("every starter with an assistant step answers typed questions at its menus", () => {
  for (const template of FLOW_TEMPLATES) {
    const nodes = Object.values(template.definition.nodes);
    const assistant = nodes.find((node) => node.type === "ai");
    if (!assistant) continue;
    const opening = template.definition.nodes[template.definition.start];
    const menus = nodes.filter((node) => node.type === "choice" && node.options.some((option) => option.next === assistant.id));
    assert.ok(menus.length, `${template.id} offers the assistant from a menu`);
    for (const item of menus) assert.equal((item as { elseNext?: string }).elseNext, assistant.id, `${template.id}.${item.id}`);
    if (opening.type === "choice") assert.equal(opening.elseNext, assistant.id, `${template.id} opening menu`);
  }
});

test("a nudge never nudges again: no 'if no reply' route leads to a question that has one", () => {
  for (const template of FLOW_TEMPLATES) {
    for (const node of Object.values(template.definition.nodes)) {
      const route = "noReply" in node ? node.noReply?.next : undefined;
      if (!route) continue;
      const nudge = template.definition.nodes[route];
      assert.ok(nudge, `${template.id}.${node.id}`);
      assert.equal("noReply" in nudge ? nudge.noReply : undefined, undefined, `${template.id}.${route} would chase the customer`);
    }
  }
});

test("general assistant: a typed question at the welcome menu is answered", async () => {
  const { ctx } = harness();
  const results = await talk(DEFAULT_FLOW, ctx, ["hi", "what's your warranty?"]);
  assert.match(said(results[0]), /just type your question/);
  assert.equal(said(results[1]), "AI ANSWER");
});

test("general assistant: a customer we know is not asked who they are, or for a number", async () => {
  const { ctx, calls } = harness();
  const known = { greeting: "Hey Thandi 👋", known: "1", name: "Thandi", first_name: "Thandi" };
  const results = await talk(DEFAULT_FLOW, ctx, ["hi", tap("welcome", "book"), "brakes are squeaking", tap("chooseSlot", "2030-01-15_09:00")], known);
  assert.match(said(results[1]), /Sure thing, Thandi/);
  assert.equal(results[1].session?.nodeId, "bookService", "straight to what they need");
  assert.doesNotMatch(results.map(said).join("\n"), /who am I chatting to|best number/i);
  assert.deepEqual(calls.slots, ["2030-01-15_09:00"]);
  assert.match(said(results[3]), /you're booked for Tue 15 Jan · 09:00/);

  const stranger = await talk(DEFAULT_FLOW, harness().ctx, ["hi", tap("welcome", "book"), "Sipho", "082 555 0101"]);
  assert.match(said(stranger[1]), /who am I chatting to/);
  assert.match(said(stranger[2]), /Thanks, Sipho!.*best number/);
  assert.equal(stranger[3].session?.nodeId, "bookService");
});

test("general assistant: 'talk to someone' says what will happen — by whether anyone is there", async () => {
  const open = harness();
  const openResult = last(await talk(DEFAULT_FLOW, open.ctx, ["hi", tap("welcome", "human")]));
  assert.ok(openResult.handedOff);
  assert.match(said(openResult), /getting one of the team for you now/);
  assert.equal(open.calls.handoffs[0].reason, "Asked to talk to a person");

  const closed = harness({ openNow: async () => false });
  const closedResult = last(await talk(DEFAULT_FLOW, closed.ctx, ["hi", tap("welcome", "human")]));
  assert.ok(closedResult.handedOff);
  assert.match(said(closedResult), /closed at the moment/);
  assert.doesNotMatch(said(closedResult), /for you now/);
  assert.equal(closed.calls.handoffs[0].reason, "Asked to talk to a person (after hours)");
});

test("general assistant: a booking left half-way gets one nudge, with a call back as the way out", async () => {
  const { ctx, calls } = harness();
  const results = await talk(DEFAULT_FLOW, ctx, ["hi", tap("welcome", "book"), "Sipho", "082 555 0101", { text: "", timedOut: true }, tap("bookNudge", "call")]);
  assert.match(said(results[4]), /Still keen to get booked in/);
  assert.ok(last(results).handedOff);
  assert.equal(calls.handoffs[0].reason, "Service booking: asked for a call");
  assert.match(calls.handoffs[0].summary ?? "", /Sipho/);
});

test("general assistant: fully booked is said once, and the team is told what the customer needs", async () => {
  const { ctx, calls } = harness({ availableSlots: async () => [] });
  const results = await talk(DEFAULT_FLOW, ctx, ["hi", tap("welcome", "book"), "Sipho", "082 555 0101", "brakes are squeaking"]);
  const end = last(results);
  assert.ok(end.handedOff);
  assert.equal(end.messages.length, 1, "one message, not an apology followed by a second apology");
  assert.match(said(end), /fully booked online/);
  assert.deepEqual(calls.handoffs, [{ reason: "Service booking: no open slots online", summary: "Sipho needs: brakes are squeaking" }]);
});

test("lead capture: the details are read back, and nothing is sent to the team until the customer says yes", async () => {
  const flow = flowTemplate("lead_capture").definition;
  const { ctx, calls } = harness({ openNow: async () => false });
  const results = await talk(flow, ctx, ["hi", "I need a quote for a fleet of 6", "Sipho", "082 555 0101", tap("emailAsk", "no")]);
  const readBack = said(last(results));
  for (const detail of ["Sipho", "082 555 0101", "I need a quote for a fleet of 6"]) assert.ok(readBack.includes(detail), detail);
  assert.equal(calls.bookings.length, 0, "not created before the customer confirms");

  const sent = await runFlow(flow, last(results).session!, tap("check", "yes"), ctx);
  assert.equal(calls.bookings.length, 1);
  assert.equal(calls.bookings[0].action, "lead");
  assert.match(said(sent), /with the team now, Sipho/);
  assert.match(said(sent), /closed right now/, "after hours it does not promise a reply 'shortly'");
});

test("lead capture: a failed enquiry is never called done, and reaches a person with the details", async () => {
  const flow = flowTemplate("lead_capture").definition;
  const { ctx, calls } = harness({ createBooking: async () => ({ ok: false, reason: "No pipeline stage" }) });
  const results = await talk(flow, ctx, ["hi", "a quote please", "Sipho", "082 555 0101", tap("emailAsk", "no"), tap("check", "yes")]);
  const end = last(results);
  assert.ok(end.handedOff);
  assert.doesNotMatch(said(end), /with the team now/);
  assert.equal(calls.handoffs[0].reason, "Enquiry could not be created");
  assert.match(calls.handoffs[0].summary ?? "", /Sipho \(082 555 0101\): a quote please/);
});

test("smart enquiry: what the customer already said is not asked again", async () => {
  const flow = flowTemplate("smart_enquiry").definition;
  const all = harness({ extractData: async () => ({ ok: true, values: { name: "Sipho", phone: "082 555 0101", service: "Quote for a fleet of 6" } }) });
  const told = await talk(flow, all.ctx, ["hi", "Hi, Sipho here on 082 555 0101 — I need a quote for a fleet of 6"]);
  assert.equal(last(told).session?.nodeId, "check", "straight to the read-back");
  assert.match(said(last(told)), /Sipho[\s\S]*082 555 0101[\s\S]*fleet of 6/);

  const partial = harness({ extractData: async () => ({ ok: true, values: { name: "Sipho" } }) });
  const asked = await talk(flow, partial.ctx, ["hi", "Sipho here, need a quote"]);
  assert.equal(last(asked).session?.nodeId, "askPhone", "only the missing number is asked for");
  assert.match(said(last(asked)), /Thanks, Sipho/);
});

test("smart enquiry: with no AI it still works — one question at a time — and the enquiry keeps the customer's own words", async () => {
  const flow = flowTemplate("smart_enquiry").definition;
  const { ctx, calls } = harness({ extractData: async () => ({ ok: false, reason: "AI extraction is not configured" }) });
  const results = await talk(flow, ctx, ["hi", "need a quote for 6 units", "Sipho", "082 555 0101", tap("check", "yes")]);
  assert.equal(results[1].session?.nodeId, "askName");
  assert.equal(results[2].session?.nodeId, "askPhone");
  assert.equal(calls.bookings[0].vars.message, "need a quote for 6 units");
  assert.equal(calls.handoffs.length, 0, "an AI that is switched off is not a failure the customer should feel");
});

test("smart enquiry: fixing one detail re-asks that detail only", async () => {
  const flow = flowTemplate("smart_enquiry").definition;
  const { ctx } = harness({ extractData: async () => ({ ok: true, values: { name: "Sipho", phone: "082 555 0101" } }) });
  const results = await talk(flow, ctx, ["hi", "Sipho, 082 555 0101, quote please", tap("check", "fix"), tap("fix", "phone"), "083 000 1111"]);
  assert.equal(last(results).session?.nodeId, "check");
  assert.match(said(last(results)), /Sipho[\s\S]*083 000 1111/);
});

test("front desk: closed is said up front, and a message can still be left", async () => {
  const flow = flowTemplate("front_desk").definition;
  const closed = harness({ openNow: async () => false });
  const results = await talk(flow, closed.ctx, ["hi", tap("closed", "msg"), "Sipho", "082 555 0101", "my invoice looks wrong"]);
  assert.match(said(results[0]), /closed right now/);
  assert.equal(closed.calls.bookings[0].vars.message, "my invoice looks wrong");
  assert.match(said(last(results)), /first thing the team sees when we open/);
  assert.equal(closed.calls.handoffs.length, 0);

  const open = harness();
  assert.doesNotMatch(said((await talk(flow, open.ctx, ["hi"]))[0]), /closed/);
  assert.equal(said(last(await talk(flow, harness({ openNow: async () => false }).ctx, ["hi", "are you open on Saturdays?"]))), "AI ANSWER");
});

test("feedback: a happy customer is thanked, not questioned; an unhappy one reaches a person with their own words", async () => {
  const flow = flowTemplate("feedback").definition;
  const happy = harness();
  const thanks = last(await talk(flow, happy.ctx, ["hi", tap("ask", "great")]));
  assert.equal(thanks.session, null);
  assert.equal(thanks.handedOff, false);
  assert.deepEqual(happy.calls.tags, ["Feedback: happy"]);

  const unhappy = harness();
  const results = await talk(flow, unhappy.ctx, ["hi", tap("ask", "bad"), "waited two hours and nobody called", tap("badCall", "yes")]);
  assert.match(said(results[1]), /really sorry/);
  assert.ok(last(results).handedOff);
  assert.deepEqual(unhappy.calls.handoffs, [{ reason: "Unhappy customer — wants a call", summary: "waited two hours and nobody called" }]);

  // No customer record to tag: the conversation carries on regardless.
  const untagged = harness({ updateCrm: async () => ({ ok: false, reason: "No customer record" }) });
  assert.match(said(last(await talk(flow, untagged.ctx, ["hi", tap("ask", "great")]))), /wonderful to hear/);
});

test("an AI read and one question for the same value are a pair, not a 'captured twice' warning — a third writer still is", () => {
  const flow: Flow = {
    start: "read",
    nodes: {
      read: { id: "read", type: "extract", instruction: "phone = their number", fields: ["phone"], next: "has", failureNext: "has" },
      has: { id: "has", type: "condition", condition: { variable: "phone", operator: "exists" }, trueNext: "end", falseNext: "ask" },
      ask: { id: "ask", type: "capture", text: "Number?", variable: "phone", next: "end" },
      end: { id: "end", type: "end" },
    },
  };
  assert.ok(!validateFlow(flow).some((issue) => issue.code === "variable.reused"));
  const third: Flow = { ...flow, nodes: { ...flow.nodes, end: { id: "end", type: "capture", text: "Again?", variable: "phone" } } };
  assert.ok(validateFlow(third).some((issue) => issue.code === "variable.reused" && issue.nodeId === "end"));
  const twoQuestions: Flow = { start: "a", nodes: { a: { id: "a", type: "capture", text: "A?", variable: "x", next: "b" }, b: { id: "b", type: "capture", text: "B?", variable: "x" } } };
  assert.ok(validateFlow(twoQuestions).some((issue) => issue.code === "variable.reused"));
});

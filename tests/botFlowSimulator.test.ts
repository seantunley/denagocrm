import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Module, { createRequire } from "node:module";
import * as flowEngine from "../src/lib/flow";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * The simulator is a server action: it gates on `requireOwner` and reads the
 * draft through Prisma. Everything it reaches for OUTSIDE the graph engine is
 * swapped so the shipped action itself can be executed here, anchored on the
 * requesting file so no stub leaks elsewhere. The engine is deliberately NOT
 * stubbed — running the real one is the whole point of the simulator.
 */
type Loader = (
  this: unknown,
  request: string,
  parent: { filename?: string } | undefined,
  isMain: boolean,
) => unknown;

let draftDefinition = "{}";

const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only" || request === "client-only") return {};
  if (!(parent?.filename ?? "").endsWith("flowSimulator.ts")) return realLoad.call(this, request, parent, isMain);
  if (request === "@/lib/db") return { prisma: { botFlow: { findUnique: async () => ({ id: "flow-1", definition: draftDefinition }) } } };
  if (request === "@/lib/auth") return { requireOwner: async () => ({ id: "owner-1" }) };
  if (request === "@/lib/botAnswers") return { priceList: async () => "Prices", coloursList: async () => "Colours" };
  if (request === "@/lib/flow") return flowEngine;
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const require_ = createRequire(import.meta.url);
const simulator = require_("../src/app/actions/flowSimulator.ts") as typeof import("../src/app/actions/flowSimulator");

test("flow simulator runs the real engine but imports no CRM write helpers", () => {
  const action = src("src/app/actions/flowSimulator.ts");
  assert.match(action, /runFlow\(flow, session, turn/);
  assert.doesNotMatch(action, /createIntakeLead|createLeadRecord|reserveSlot|sendWhatsApp|sendDirectMessage|tgSend|prisma\.activity\.create/);
  // The trace now names the executing node as well, so these stay anchored on
  // the "would" wording that proves the simulator only describes the effect.
  assert.match(action, /CRM: node .*would create/);
  assert.match(action, /CRM: node .*would reserve slot/);
});

test("simulated AI and handoff are explicit test effects", () => {
  const action = src("src/app/actions/flowSimulator.ts");
  assert.match(action, /simulateAiHandoff/);
  assert.match(action, /\[Simulator\] AI response/);
  assert.match(action, /Handoff: would pause bot and notify team/);
});

test("simulator page remains owner-gated and clearly draft-only", () => {
  const page = src("src/app/(app)/bot-builder/[id]/test/page.tsx");
  assert.match(page, /await requireOwner\(\)/);
  assert.match(page, /production graph engine/);
  assert.match(page, /every write\/send replaced by a simulator effect/);

  const editor = src("src/app/(app)/bot-builder/[id]/page.tsx");
  assert.match(editor, /Test saved draft/);
});

test("the Variables panel shows what the LAST turn produced, even when that turn ended the flow", async () => {
  // `vars: result.session?.vars ?? session.vars` looked harmless, but `session` is
  // null on handoff and at the end of a graph — precisely where an author is
  // checking what the flow captured. The panel showed the state from BEFORE the
  // final turn: no booking id, no journey run, and none of the answers the last
  // nodes had just written.
  draftDefinition = JSON.stringify({
    start: "lookup",
    nodes: {
      lookup: { id: "lookup", type: "booking", action: "lookup", next: "enrol" },
      enrol: { id: "enrol", type: "journey", journeyId: "service-reminder", next: "end" },
      end: { id: "end", type: "end" },
    },
  });

  const ended = await simulator.simulateFlowTurn({ flowId: "flow-1", session: null, text: "" });
  assert.equal(ended.ok, true);
  assert.equal(ended.session, null, "the graph ran to its end node");
  assert.equal(ended.vars.booking_id, "simulated-activity-id", "the looked-up booking must still be visible");
  assert.equal(ended.vars.booking_slot, "Tue 15 Jan · 09:00 (simulated)");
  assert.equal(ended.vars.journey_run_id, "simulated-journey-run");
});

test("the Variables panel survives a handoff too", async () => {
  draftDefinition = JSON.stringify({
    start: "askName",
    nodes: {
      askName: { id: "askName", type: "capture", text: "What's your name?", variable: "name", next: "toHuman" },
      toHuman: { id: "toHuman", type: "handoff", text: "Putting you through." },
    },
  });

  const prompt = await simulator.simulateFlowTurn({ flowId: "flow-1", session: null, text: "" });
  assert.equal(prompt.session?.nodeId, "askName");

  const handedOff = await simulator.simulateFlowTurn({ flowId: "flow-1", session: prompt.session, text: "Thabo" });
  assert.equal(handedOff.handedOff, true);
  assert.equal(handedOff.session, null);
  assert.equal(handedOff.vars.name, "Thabo", "the answer that triggered the handoff must not vanish from the panel");
  assert.ok(handedOff.trace.includes("Stop: handed off"));
});

test("simulator UI exposes transcript, execution trace, variables and file input", () => {
  const ui = src("src/components/FlowSimulator.tsx");
  assert.match(ui, /Customer preview/);
  assert.match(ui, /Execution trace/);
  assert.match(ui, /Variables/);
  assert.match(ui, /sample-file\.jpg/);
  assert.match(ui, /AI hands off/);
});

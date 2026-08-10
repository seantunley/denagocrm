import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runFlow, type Flow, type FlowCtx } from "../src/lib/flow";
import { flowErrors, validateFlow } from "../src/lib/flowValidation";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * Strip comments before scanning for a banned call — the same problem, and the
 * same fix, as tests/oneAutomationEngine.test.ts: the note explaining why this
 * module deliberately avoids `enrollJourneyNow()` names the very function the
 * guard below scans for.
 *
 * Whole-line `//` only, so a `https://` inside a string literal survives.
 */
const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const shipped = (rel: string) => stripComments(src(rel));

const baseCtx: FlowCtx = {
  aiReply: async () => ({ reply: "AI", handoff: false }),
  dynamicAnswer: async () => "dynamic",
  createBooking: async () => ({ ok: true }),
  handoff: async () => {},
};

test("Start Journey is an explicit automatic node and flow continues immediately", async () => {
  const flow: Flow = {
    start: "journey",
    nodes: {
      journey: { id: "journey", type: "journey", journeyId: "journey-1", text: "Started: {{journey_started}}", next: "end" },
      end: { id: "end", type: "end" },
    },
  };
  let call: { journeyId: string; nodeId: string } | null = null;
  const result = await runFlow(flow, { nodeId: null, vars: {} }, { text: "" }, {
    ...baseCtx,
    startJourney: async (journeyId, vars, nodeId) => {
      call = { journeyId, nodeId };
      vars.journey_started = "yes";
      vars.journey_run_id = "run-1";
      return { ok: true, reason: "enrolled" };
    },
  });
  assert.deepEqual(call, { journeyId: "journey-1", nodeId: "journey" });
  assert.equal(result.session, null);
  assert.equal(result.handedOff, false);
  assert.match(result.messages[0]?.type === "text" ? result.messages[0].text : "", /Started: yes/);
});

test("pure compiler rejects a Journey node without a selected Journey", () => {
  const flow: Flow = { start: "j", nodes: { j: { id: "j", type: "journey", journeyId: "", next: "end" }, end: { id: "end", type: "end" } } };
  assert.ok(flowErrors(validateFlow(flow)).some((issue) => issue.code === "journey.missing"));
});

test("direct enrolment uses the existing Journey runner rather than scheduling a trigger sweep", () => {
  const code = src("src/lib/journeyDirectEnrollment.ts");
  assert.match(code, /enqueueJourneyRun\(/);
  assert.match(code, /getActiveVersion\(journey\)/);
  assert.match(code, /eventKey: input\.eventKey/);
  assert.match(code, /outcome\.refusal === "duplicate_event"/);
  assert.doesNotMatch(shipped("src/lib/journeyDirectEnrollment.ts"), /enrollJourneyNow|scheduleJourney|scheduleJourneyInternal|processScheduledJourneys/);
});

test("Flow Journey enrolment requires an existing customer and retry-stable provider event identity", () => {
  const actions = src("src/lib/flowActions.ts");
  assert.match(actions, /existingJourneyEntity/);
  const helper = actions.slice(actions.indexOf("async function existingJourneyEntity"), actions.indexOf("async function firstUserId"));
  assert.doesNotMatch(helper, /contact\.create|ensureContact/);
  assert.match(actions, /botActionKey\(nodeId, `journey:\$\{journeyId\}`\)/);
  assert.match(actions, /enrollEntityInJourney\(/);
});

test("publication validates that every Journey target is still active", () => {
  const server = src("src/lib/flowValidationServer.ts");
  // Scoped to the publishing workspace now — another tenant's active Journey
  // must not satisfy the check.
  assert.match(server, /prisma\.journey\.findMany\(\{ where: \{ id: \{ in: ids \}, status: "active", \.\.\.\(await journeyScope\(\)\) \}/);
  assert.match(server, /code: "journey\.unavailable"/);
  assert.match(server, /severity: "error"/);
});

test("visual editor exposes only server-supplied active Journeys", () => {
  const page = src("src/app/(app)/bot-builder/[id]/page.tsx");
  assert.match(page, /prisma\.journey\.findMany/);
  assert.match(page, /where: \{ status: "active", \.\.\.\(await journeyScope\(\)\) \}/);
  // The canvas also receives the draft's updatedAt now, to fence its saves.
  assert.match(page, /<FlowBuilder flowId=\{row\.id\} initial=\{flow\} journeys=\{journeys\}/);
  assert.match(page, /<FlowAiDraftForm flowId=\{row\.id\} \/>/);

  const builder = src("src/components/FlowBuilder.tsx");
  assert.match(builder, /label: "Start Journey"/);
  assert.match(builder, /Select an active Journey/);
  assert.match(builder, /Flow continues immediately/);
});

test("AI draft generation may use only an explicit active Journey allow-list", () => {
  const ai = src("src/lib/flowAiDraft.ts");
  assert.match(ai, /ACTIVE JOURNEYS — the ONLY journeyId values you may use/);
  assert.match(ai, /allowedJourneyIds/);
  assert.match(ai, /journey\.ai_unapproved/);
  assert.match(ai, /Do not invent email\/SMS\/webhook\/code\/wait nodes/);
});

test("simulator mocks Journey enrolment and never invokes the Journey engine", () => {
  const simulator = src("src/app/actions/flowSimulator.ts");
  assert.match(simulator, /startJourney: async/);
  assert.match(simulator, /would enrol this customer/);
  assert.match(simulator, /simulated-journey-run/);
  assert.doesNotMatch(simulator, /enrollEntityInJourney|enqueueJourneyRun|scheduleJourney/);
});

test("Flow never gains its own scheduler or wait node", () => {
  const flow = src("src/lib/flow.ts");
  assert.doesNotMatch(flow, /type: "wait"|type: "delay"|setTimeout\(|scheduleJourney/);
  const oneEngine = src("tests/oneAutomationEngine.test.ts");
  assert.match(oneEngine, /exactly one automation engine/i);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runFlow, type Flow, type FlowCtx } from "../src/lib/flow";
import { flowTemplate } from "../src/lib/flowTemplates";
import { flowErrors, validateFlow } from "../src/lib/flowValidation";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const baseCtx: FlowCtx = {
  aiReply: async () => ({ reply: "AI", handoff: false }),
  dynamicAnswer: async () => "dynamic",
  createBooking: async () => {},
  handoff: async () => {},
};

test("booking lookup may populate customer-owned booking variables before deterministic branching", async () => {
  const flow: Flow = {
    start: "lookup",
    nodes: {
      lookup: { id: "lookup", type: "booking", action: "lookup", next: "gate" },
      gate: { id: "gate", type: "condition", condition: { variable: "booking_found", operator: "equals", value: "yes" }, trueNext: "found", falseNext: "none" },
      found: { id: "found", type: "message", text: "Found {{booking_slot}}", next: "end" },
      none: { id: "none", type: "message", text: "None", next: "end" },
      end: { id: "end", type: "end" },
    },
  };
  let managed = false;
  const result = await runFlow(flow, { nodeId: null, vars: {} }, { text: "" }, {
    ...baseCtx,
    manageBooking: async (action, vars) => {
      assert.equal(action, "lookup");
      managed = true;
      vars.booking_found = "yes";
      vars.booking_id = "activity-1";
      vars.booking_slot = "Mon 10 Aug · 10:00";
      return { ok: true };
    },
  });
  assert.equal(managed, true);
  assert.equal(result.messages[0]?.type, "text");
  assert.match(result.messages[0]?.type === "text" ? result.messages[0].text : "", /10:00/);
});

test("reschedule slot nodes call the move primitive instead of the new-booking callback", async () => {
  const flow: Flow = {
    start: "slot",
    nodes: {
      slot: { id: "slot", type: "slots", action: "reschedule", text: "Pick", next: "done" },
      done: { id: "done", type: "message", text: "Moved to {{booking_slot}}", next: "end" },
      end: { id: "end", type: "end" },
    },
  };
  const first = await runFlow(flow, { nodeId: null, vars: { booking_id: "activity-1" } }, { text: "" }, {
    ...baseCtx,
    availableSlots: async () => [{ id: "2026-08-11_10:00", label: "Tue 11 Aug · 10:00" }],
  });
  assert.equal(first.session?.nodeId, "slot");
  let booked = 0;
  let moved = 0;
  const second = await runFlow(flow, first.session!, { text: "", choiceId: "slot|2026-08-11_10:00" }, {
    ...baseCtx,
    bookSlot: async () => { booked += 1; return { ok: true }; },
    rescheduleSlot: async (_slotId, vars) => { moved += 1; assert.equal(vars.booking_id, "activity-1"); return { ok: true, label: "Tue 11 Aug · 10:00" }; },
  });
  assert.equal(booked, 0);
  assert.equal(moved, 1);
  assert.match(second.messages[0]?.type === "text" ? second.messages[0].text : "", /Tue 11 Aug/);
});

test("workshop reschedule is one locked move, never create-new then cancel-old", () => {
  const code = src("src/lib/bookingSlots.ts");
  const move = code.slice(code.indexOf("export async function rescheduleWorkshopBooking"));
  assert.match(move, /lockWorkshopBooking\(tx, input\.bookingId, tenantId\)/);
  assert.match(move, /claimSlotCapacity\(tx, destination, config\.capacity, tenantId\)/);
  assert.match(move, /tx\.activity\.update\(/);
  assert.doesNotMatch(move, /tx\.activity\.create\(/);
  assert.doesNotMatch(move, /status: "cancelled"/);
});

test("cancel and reschedule share the per-booking advisory lock", () => {
  const code = src("src/lib/bookingSlots.ts");
  assert.match(code, /workshop-booking:\$\{tenantId \?\? "global"\}:\$\{bookingId\}/);
  const calls = code.match(/lockWorkshopBooking\(tx, input\.bookingId, tenantId\)/g) ?? [];
  assert.equal(calls.length, 2);
});

test("booking management starter compiles across every connected channel", () => {
  const flow = flowTemplate("booking_management").definition;
  assert.deepEqual(flowErrors(validateFlow(flow, ["whatsapp", "messenger", "instagram", "telegram"])), []);
  assert.ok(Object.values(flow.nodes).some((node) => node.type === "booking" && node.action === "lookup"));
  assert.ok(Object.values(flow.nodes).some((node) => node.type === "booking" && node.action === "cancel"));
  assert.ok(Object.values(flow.nodes).some((node) => node.type === "slots" && node.action === "reschedule"));
});

test("visual builder exposes booking management actions and their runtime variables", () => {
  const builder = src("src/components/FlowBuilder.tsx");
  assert.match(builder, /Find customer's next service booking/);
  assert.match(builder, /Cancel \{\{booking_id\}\}/);
  assert.match(builder, /Move \{\{booking_id\}\} to a new slot/);
  assert.match(builder, /booking_found/);
  assert.match(builder, /booking_rescheduled/);
});

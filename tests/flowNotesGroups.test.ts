import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runFlow, type Flow, type FlowCtx } from "../src/lib/flow";
import { validateFlow } from "../src/lib/flowValidation";

// Node-RED's comment node and groups (Sean, 2026-11-02): notes and coloured boxes on the canvas, for the team only.
const flow: Flow = {
  start: "hi",
  nodes: {
    hi: { id: "hi", type: "message", text: "Hello!", next: "end" },
    end: { id: "end", type: "end" },
    tip: { id: "tip", type: "note", text: "Update the brochure each quarter", color: "yellow" },
    box: { id: "box", type: "group", label: "Welcome", color: "blue", width: 600, height: 300 },
  },
};
const ctx = { dynamicAnswer: async () => "", aiReply: async () => ({ reply: "", handoff: false }), handoff: async () => {} } as unknown as FlowCtx;

test("notes and groups are never run or sent, and are not 'unreachable'", async () => {
  const r = await runFlow(flow, { nodeId: null, vars: {} }, { text: "hi" }, ctx);
  assert.deepEqual(r.messages, [{ type: "text", text: "Hello!" }]);
  assert.deepEqual(validateFlow(flow), [], "no unreachable warnings for the note or the group");
});

test("a note or group can't be the start", () => {
  const codes = validateFlow({ ...flow, start: "tip" }).map((i) => i.code);
  assert.ok(codes.includes("graph.start"));
});

test("builder: canvas-only — no handles, out of step pickers, never the start, a group behind the steps at its saved size", () => {
  const builder = readFileSync("src/components/FlowBuilder.tsx", "utf8");
  const card = builder.slice(builder.indexOf("function NodeCard"), builder.indexOf("if (errors"));
  const annotations = card.slice(card.indexOf('if (n.type === "note")'), card.indexOf("const meta = TYPE_META[n.type]"));
  assert.doesNotMatch(annotations, /<Handle/, "nothing can be wired to or from them");
  assert.match(builder, /const nodeOptions = rfNodes\.filter\(\(n\) => !isAnnotation\(n\.data\.flow\)\)/);
  assert.match(builder, /\{!isStart && !isAnnotation\(node\) && <button type="button" onClick=\{onMakeStart\}/);
  assert.match(builder, /n\.type === "group" \? \{ \.\.\.base, zIndex: -1, style: \{ width: n\.width \?\? 520, height: n\.height \?\? 320 \} \}/);
  assert.match(builder, /change\.type !== "dimensions" \|\| change\.resizing !== false/, "a resize is saved on the group");
});

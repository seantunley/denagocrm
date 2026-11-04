import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pinSubflows, runFlow, type Flow, type FlowCtx } from "../src/lib/flow";

// Review, 2026-11-02: a published flow's "Run subflow" ran the subflow's NEWEST version, so publishing a shared
// subflow silently changed every live flow using it.
const parent: Flow = {
  start: "sub",
  nodes: {
    sub: { id: "sub", type: "subflow", flowId: "shared", next: "end", failureNext: "end" },
    other: { id: "other", type: "subflow", flowId: "neverPublished", next: "end", failureNext: "end" },
    end: { id: "end", type: "end" },
  },
};

test("publishing pins each subflow step to the subflow's newest version; one never published is left alone", () => {
  const pinned = pinSubflows(parent, new Map([["shared", { id: "v7", version: 7 }]]));
  assert.deepEqual(pinned.nodes.sub, { ...parent.nodes.sub, versionId: "v7", version: 7 });
  assert.deepEqual(pinned.nodes.other, parent.nodes.other);
  assert.equal((parent.nodes.sub as { versionId?: string }).versionId, undefined, "the input (the draft) is not changed");
});

test("at run time the pinned version is the one asked for; an unpinned (older) version asks for the newest", async () => {
  const asked: (string | undefined)[] = [];
  const ctx = {
    dynamicAnswer: async () => "", aiReply: async () => ({ reply: "", handoff: false }), handoff: async () => {},
    loadSubflow: async (_flowId: string, versionId?: string) => { asked.push(versionId); return { start: "e", nodes: { e: { id: "e", type: "end" } } } as Flow; },
  } as unknown as FlowCtx;
  await runFlow(pinSubflows(parent, new Map([["shared", { id: "v7", version: 7 }]])), { nodeId: null, vars: {} }, { text: "hi" }, ctx);
  await runFlow(parent, { nodeId: null, vars: {} }, { text: "hi" }, ctx);
  assert.deepEqual(asked, ["v7", undefined]);
});

test("the publish stores the pinned definition, and the runtime loads exactly that version of that flow", () => {
  const publishing = readFileSync("src/lib/flowPublishing.ts", "utf8");
  assert.match(publishing, /definition: latest\.size \? JSON\.stringify\(pinSubflows\(JSON\.parse\(flow\.definition\) as Flow, latest\)\) : flow\.definition/);
  const tools = readFileSync("src/lib/flowRuntimeTools.ts", "utf8");
  assert.match(tools, /findFirst\(\{ where: \{ id: versionId, tenantId, flowId \}/, "this workspace's, and a version of that same flow");
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Flow } from "../src/lib/flow";
import { changedSince } from "../src/lib/flowVersionDiff";

// Node-RED's "modified" dot before deploy (Sean, 2026-11-04).
const live: Flow = {
  start: "menu",
  nodes: {
    menu: { id: "menu", type: "choice", text: "Hi!", options: [{ id: "o1", label: "Prices", next: "prices" }] },
    prices: { id: "prices", type: "message", text: "From R29,999", next: "end" },
    end: { id: "end", type: "end" },
  },
};

test("a reworded step is edited, a new one is new, an untouched one is not marked", () => {
  const draft: Flow = structuredClone(live);
  (draft.nodes.prices as { text: string }).text = "From R27,999";
  draft.nodes.extra = { id: "extra", type: "message", text: "New!", next: "end" };
  assert.deepEqual(changedSince(live, draft), { added: ["extra"], edited: ["prices"] });
});

test("re-wiring a step marks it; moving it on the canvas does not", () => {
  const draft: Flow = structuredClone(live);
  draft.nodes.menu = { ...draft.nodes.menu, options: [{ id: "o1", label: "Prices", next: "end" }] } as Flow["nodes"][string];
  assert.deepEqual(changedSince(live, draft).edited, ["menu"], "the button now goes elsewhere");
  const moved = { ...structuredClone(live), positions: { menu: { x: 999, y: 1 } } } as Flow;
  assert.deepEqual(changedSince(live, moved), { added: [], edited: [] });
});

test("the builder marks the canvas from the last published version; publishing lists what changes", () => {
  const builder = readFileSync("src/components/FlowBuilder.tsx", "utf8");
  assert.match(builder, /const \{ added, edited \} = changedSince\(publishedFlow, currentFlow\);/);
  assert.match(builder, /<ChangedContext\.Provider value=\{changedSteps\}>/);
  const page = readFileSync("src/app/(app)/bot-builder/[id]/page.tsx", "utf8");
  assert.match(page, /orderBy: \{ version: "desc" \}, select: \{ version: true, definition: true \}/);
  const list = readFileSync("src/app/(app)/bot-builder/page.tsx", "utf8");
  assert.match(list, /changes=\{live \? diffFlowVersions\(live\.definition, f\.definition\) : undefined\}/);
  assert.match(readFileSync("src/components/PublishFlowButton.tsx", "utf8"), /<FlowDiffList diff=\{changes\}/);
});

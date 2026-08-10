import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { insertFlowSnippet, type FlowSnippet } from "../src/lib/flowSnippetDefinition";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const target: FlowSnippet["definition"] = {
  start: "welcome",
  nodes: {
    welcome: { id: "welcome", type: "message", text: "Welcome", next: "end" },
    end: { id: "end", type: "end" },
  },
  positions: { welcome: { x: 0, y: 0 }, end: { x: 280, y: 0 } },
};

const snippet: FlowSnippet["definition"] = {
  start: "ask",
  nodes: {
    ask: { id: "ask", type: "choice", text: "Pick", options: [{ id: "yes", label: "Yes", next: "done" }] },
    done: { id: "done", type: "message", text: "Done", next: "end" },
    end: { id: "end", type: "end" },
  },
  positions: { ask: { x: 0, y: 0 }, done: { x: 280, y: 0 }, end: { x: 560, y: 0 } },
};

test("inserting a block copies nodes with new ids and rewrites internal references", () => {
  const inserted = insertFlowSnippet(target, snippet, "sales");
  assert.equal(inserted.insertedStart, "sales_ask");
  assert.ok(inserted.definition.nodes.sales_ask);
  assert.ok(inserted.definition.nodes.sales_done);
  assert.ok(inserted.definition.nodes.sales_end);
  const choice = inserted.definition.nodes.sales_ask;
  assert.equal(choice.type, "choice");
  if (choice.type === "choice") assert.equal(choice.options[0].next, "sales_done");
  const done = inserted.definition.nodes.sales_done;
  if (done.type === "message") assert.equal(done.next, "sales_end");
});

test("target start and existing graph remain unchanged after insertion", () => {
  const inserted = insertFlowSnippet(target, snippet, "block");
  assert.equal(inserted.definition.start, "welcome");
  assert.deepEqual(inserted.definition.nodes.welcome, target.nodes.welcome);
  assert.deepEqual(target.nodes, {
    welcome: { id: "welcome", type: "message", text: "Welcome", next: "end" },
    end: { id: "end", type: "end" },
  });
});

test("block insertion creates no runtime reference back to the source snippet", () => {
  const inserted = insertFlowSnippet(target, snippet, "block");
  const encoded = JSON.stringify(inserted.definition);
  assert.doesNotMatch(encoded, /snippetId|sourceFlowId|callSubflow|subflow/);
});

test("saving reusable blocks requires a compiler-clean owner draft", () => {
  const action = src("src/app/actions/flowSnippets.ts");
  assert.match(action, /await requireOwner\(\)/);
  assert.match(action, /flowErrors\(validateFlow\(definition, await enabledFlowChannels\(\)\)\)/);
  assert.match(action, /if \(errors\.length\) return/);
});

test("insertion uses optimistic concurrency so it cannot overwrite a canvas save", () => {
  const action = src("src/app/actions/flowSnippets.ts");
  assert.match(action, /where: \{ id: flowId, definition: row\.definition, \.\.\.scope \}/);
  assert.match(action, /if \(updated\.count !== 1\) return/);
});

test("flow block UI explicitly explains copy semantics", () => {
  const page = src("src/app/(app)/bot-builder/[id]/blocks/page.tsx");
  assert.match(page, /runtime dependency/);
  assert.match(page, /saved block is a snapshot/);
  assert.match(page, /Insert copy/);
  assert.match(page, /connect its entry node/);
});

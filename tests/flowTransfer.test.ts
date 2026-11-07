import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Flow } from "../src/lib/flow";
import { clearForeignRefs, flowFileName, parseFlowFile, toFlowFile, workspaceRefs } from "../src/lib/flowTransfer";

// Node-RED's import/export (Sean, 2026-11-04): a flow as a file — and so to another workspace.
const flow: Flow & { positions: Record<string, { x: number; y: number }> } = {
  start: "doc",
  nodes: {
    doc: { id: "doc", type: "document", documentId: "doc-A", fileName: "Brochure.pdf", next: "j" },
    j: { id: "j", type: "journey", journeyId: "journey-A", next: "sub" },
    sub: { id: "sub", type: "subflow", flowId: "flow-A", versionId: "v-A", version: 3, next: "api" },
    api: { id: "api", type: "http", method: "GET", url: "https://api.example.com", headers: '{"Authorization":"Bearer secret"}', connectionId: "conn-A", next: "card" },
    card: { id: "card", type: "contactCard", staffUserId: "user-A", next: "end" },
    end: { id: "end", type: "end" },
  },
  positions: { doc: { x: 10, y: 20 } },
};

test("the file carries the draft and its layout, never a key typed into headers", () => {
  const file = toFlowFile({ name: "QR brochure", channel: "whatsapp", definition: JSON.stringify(flow) }, new Date("2026-11-04T08:00:00Z"));
  assert.equal(file.kind, "denagocrm-chatbot-flow");
  assert.deepEqual(file.flow.positions, flow.positions);
  assert.equal((file.flow.nodes.api as { headers?: string }).headers, undefined);
  const back = parseFlowFile(JSON.stringify(file));
  assert.ok(back.ok);
  assert.equal(flowFileName("QR: brochure / pack"), "QR brochure pack.flow.json");
});

test("anything that isn't an exported flow is refused, with a reason", () => {
  assert.match((parseFlowFile("nope") as { error: string }).error, /can't be read/);
  assert.match((parseFlowFile(JSON.stringify({ kind: "something-else" })) as { error: string }).error, /exported from the CRM/);
  assert.match((parseFlowFile(JSON.stringify({ kind: "denagocrm-chatbot-flow", version: 1, flow: { start: "x", nodes: {} } })) as { error: string }).error, /no starting step/);
  const bad = { kind: "denagocrm-chatbot-flow", version: 1, flow: { start: "a", nodes: { a: { id: "b", type: "message" } } } };
  assert.match((parseFlowFile(JSON.stringify(bad)) as { error: string }).error, /can't be read/);
});

test("on import: this workspace's records are kept, another's are cleared, subflow pins always dropped", () => {
  assert.deepEqual(workspaceRefs(flow).map((r) => `${r.kind}:${r.id}`).sort(), ["connection:conn-A", "document:doc-A", "journey:journey-A", "staff:user-A", "subflow:flow-A"]);
  // Same workspace: everything still exists.
  const same = clearForeignRefs(flow, new Set(["document:doc-A", "journey:journey-A", "subflow:flow-A", "connection:conn-A", "staff:user-A"]));
  assert.equal(same.cleared, 0);
  assert.equal((same.flow.nodes.doc as { documentId: string }).documentId, "doc-A");
  assert.equal((same.flow.nodes.sub as { versionId?: string }).versionId, undefined, "a publish pins it again");
  // Another workspace: nothing of A's survives.
  const other = clearForeignRefs(flow, new Set());
  assert.equal(other.cleared, 5);
  assert.deepEqual(workspaceRefs(other.flow), []);
  assert.equal((other.flow.nodes.doc as { fileName?: string }).fileName, undefined);
});

test("on import, a step's EXTRA files are kept or cleared one by one, like the first", () => {
  const multi: Flow = { start: "doc", nodes: {
    doc: { id: "doc", type: "document", documentId: "doc-A", fileName: "A.pdf", moreDocuments: [{ documentId: "doc-B", fileName: "B.pdf" }, { documentId: "doc-X", fileName: "X.pdf" }] },
  } };
  assert.deepEqual(workspaceRefs(multi).map((r) => r.id), ["doc-A", "doc-B", "doc-X"]);
  const some = clearForeignRefs(multi, new Set(["document:doc-A", "document:doc-B"]));
  assert.equal(some.cleared, 1);
  assert.deepEqual((some.flow.nodes.doc as { moreDocuments?: unknown }).moreDocuments, [{ documentId: "doc-B", fileName: "B.pdf" }]);
  const none = clearForeignRefs(multi, new Set());
  assert.equal(none.cleared, 3);
  assert.equal((none.flow.nodes.doc as { moreDocuments?: unknown }).moreDocuments, undefined);
  assert.deepEqual(workspaceRefs(none.flow), []);
});

test("owner only; checked against THIS workspace; arrives as a draft; logged", () => {
  const actions = readFileSync("src/app/actions/flowTransfer.ts", "utf8");
  assert.equal((actions.match(/await requireTenantOwner\(\);/g) ?? []).length, 2);
  assert.match(actions, /prisma\.journey\.findMany\(\{ where: \{ id: \{ in: ids\("journey"\) \}, \.\.\.\(await journeyScope\(\)\) \}/);
  assert.match(actions, /basePrisma\.tenantMember\.findMany\(\{ where: \{ tenantId, userId: \{ in: ids\("staff"\) \} \}/);
  assert.match(actions, /active: false, tenantId \}/);
  assert.match(actions, /action: "bot\.flow_imported"/);
  assert.match(actions, /action: "bot\.flow_exported"/);
});

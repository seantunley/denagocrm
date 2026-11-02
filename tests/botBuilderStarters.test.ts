import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { flowTemplate } from "../src/lib/flowTemplates";
import { validateFlow } from "../src/lib/flowValidation";

const code = (path: string) => readFileSync(path, "utf8");
const errors = (id: string) => validateFlow(flowTemplate(id).definition).filter((issue) => issue.severity === "error").map((issue) => issue.code);

test("Sean, 2026-11-02 — 'New flow' starts blank: a greeting and an end, nothing else", () => {
  const blank = flowTemplate("blank").definition;
  assert.deepEqual(Object.keys(blank.nodes).sort(), ["end", "welcome"]);
  assert.deepEqual(errors("blank"), []);
  const page = code("src/app/(app)/bot-builder/page.tsx");
  assert.match(page, /name="templateId" value="blank" \/><input type="hidden" name="name" value="New flow" \/>/);
  assert.equal(flowTemplate("no-such-template").id, "general", "an unknown template is still the general one");
});

test("the QR brochure pack: brochure, price list, contact card, a call-back offer — blocked only until the two files are chosen", () => {
  const flow = flowTemplate("qr_brochure").definition;
  const types = Object.values(flow.nodes).map((node) => node.type);
  assert.equal(types.filter((type) => type === "document").length, 2);
  assert.ok(types.includes("contactCard") && types.includes("handoff"));
  assert.deepEqual(errors("qr_brochure"), ["document.missing", "document.missing"]);
  const chosen = structuredClone(flow);
  for (const node of Object.values(chosen.nodes)) if (node.type === "document") node.documentId = "doc1";
  assert.deepEqual(validateFlow(chosen).filter((issue) => issue.severity === "error"), []);
});

test("review of #955: every new flow is a draft — the first one too; only Publish puts it live", () => {
  const action = code("src/app/actions/flow.ts");
  const fn = action.slice(action.indexOf("export async function createFlow"), action.indexOf("export async function saveFlow"));
  assert.match(fn, /active: false,/);
  assert.doesNotMatch(fn, /publishFlowSnapshot|count === 0/);
});

test("every delete in the bot builder asks first — a flow, a route, a QR code", () => {
  const page = code("src/app/(app)/bot-builder/page.tsx");
  assert.doesNotMatch(page, /<form action=\{deleteFlow\./);
  assert.match(page, /onConfirm=\{deleteFlow\.bind\(null, f\.id\)\}/);
  const routes = code("src/app/(app)/bot-builder/routes/page.tsx");
  assert.doesNotMatch(routes, /<form action=\{delete(FlowRoute|FlowQr)\./);
  assert.match(routes, /onConfirm=\{deleteFlowRoute\.bind\(null, route\.id\)\}/);
  assert.match(routes, /onConfirm=\{deleteFlowQr\.bind\(null, qr\.routeId\)\}/);
  // A refused delete says why instead of doing nothing.
  const action = code("src/app/actions/flow.ts");
  const fn = action.slice(action.indexOf("export async function deleteFlow("), action.indexOf("export async function duplicateFlow"));
  assert.match(fn, /if \(publishedVersion\) return \{ error:/);
  assert.match(fn, /if \(flow\.active\) return \{ error:/);
});

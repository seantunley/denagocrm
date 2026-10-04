import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DOC_DEFS, defaultTemplate, mergeTemplate } from "../src/lib/docTemplates";

/**
 * Audit 4.10 (Sean, 2026-10-04): a workspace without the automotive module gets
 * neutral sales-agreement clauses; automotive workspaces keep the vehicle
 * wording. Either way the clauses are the template's own and stay editable.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("new agreement templates start neutral unless automotive", () => {
  assert.doesNotMatch(defaultTemplate("agreement").bodyText ?? "", /vehicle/i);
  assert.match(defaultTemplate("agreement", { automotive: true }).bodyText ?? "", /vehicle\(s\)/);
  assert.doesNotMatch(DOC_DEFS.agreement.description + DOC_DEFS.agreement.sections.map((s) => s.label).join(), /cart|vehicle/i);
});

test("saved clauses win over either default", () => {
  const saved = mergeTemplate("agreement", { bodyText: "1. Our own terms." }, { automotive: true });
  assert.equal(saved.bodyText, "1. Our own terms.");
});

test("every place that creates a template passes the workspace's module", () => {
  const store = src("src/lib/docTemplateStore.ts");
  assert.match(store, /mergeTemplate\(key, legacy, \{ automotive \}\)/);
  assert.match(store, /defaultTemplate\(key, options\)/);
  assert.match(src("src/app/actions/documents.ts"), /defaultTemplate\(docType, \{ automotive: await isModuleEnabled\("automotive"\) \}\)/);
});

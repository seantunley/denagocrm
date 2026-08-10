import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { FLOW_TEMPLATES, flowTemplate } from "../src/lib/flowTemplates";
import { flowErrors, validateFlow } from "../src/lib/flowValidation";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("every shipped starter compiles for every connected chatbot channel", () => {
  assert.ok(FLOW_TEMPLATES.length >= 4);
  for (const template of FLOW_TEMPLATES) {
    const errors = flowErrors(validateFlow(template.definition, ["whatsapp", "messenger", "instagram", "telegram"]));
    assert.deepEqual(errors, [], `${template.id} template must publish cleanly`);
  }
});

test("unknown template ids fail safely to the general assistant", () => {
  assert.equal(flowTemplate("does-not-exist").id, "general");
  assert.equal(flowTemplate(null).id, "general");
});

test("service and sales templates use the real deterministic CRM nodes", () => {
  const service = flowTemplate("service").definition;
  assert.ok(Object.values(service.nodes).some((node) => node.type === "slots"));

  const sales = flowTemplate("sales").definition;
  assert.ok(Object.values(sales.nodes).some((node) => node.type === "booking" && node.action === "demo"));
  assert.ok(Object.values(sales.nodes).some((node) => node.type === "answer" && node.answerSource === "pricelist"));
});

test("lead-capture template collects contact details before creating the CRM enquiry", () => {
  const flow = flowTemplate("lead_capture").definition;
  const captures = Object.values(flow.nodes).filter((node) => node.type === "capture").map((node) => node.type === "capture" ? node.variable : "");
  assert.ok(captures.includes("name"));
  assert.ok(captures.includes("phone"));
  assert.ok(captures.includes("email"));
  assert.ok(Object.values(flow.nodes).some((node) => node.type === "booking" && node.action === "lead"));
});

test("create action uses the selected template definition and audits provenance", () => {
  const action = src("src/app/actions/flow.ts");
  assert.match(action, /const template = flowTemplate\(String\(formData\.get\("templateId"\)/);
  assert.match(action, /definition: JSON\.stringify\(template\.definition\)/);
  assert.match(action, /created from \$\{template\.name\} template/);
});

test("flow library exposes every shipped template as a normal draft creation form", () => {
  const page = src("src/app/(app)/bot-builder/page.tsx");
  assert.match(page, /FLOW_TEMPLATES\.map/);
  assert.match(page, /name="templateId"/);
  assert.match(page, /Use template/);
  assert.match(page, /run the simulator, then publish/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("Flowbot workspace navigation covers configure, test and operate surfaces", () => {
  const nav = src("src/components/ChatbotWorkspaceNav.tsx");
  for (const route of [
    "/chatbot",
    "/bot-builder",
    "/bot-builder/routes",
    "/chatbot/knowledge",
    "/chatbot/preview",
    "/inbox",
    "/bot-analytics",
  ]) assert.match(nav, new RegExp(route.replaceAll("/", "\\/")));
  assert.match(nav, /Configure/);
  assert.match(nav, /Test/);
  assert.match(nav, /Operate/);
});

test("flow-specific simulator and evaluation tools remain owned by the flow workspace", () => {
  const layout = src("src/app/(app)/bot-builder/[id]/layout.tsx");
  assert.match(layout, /Simulator/);
  assert.match(layout, /Evaluations/);
  assert.match(layout, /\/bot-builder\/\$\{encoded\}\/test/);
  assert.match(layout, /\/bot-builder\/\$\{encoded\}\/evaluations/);
});

test("workspace navigation has active-state, mobile-drawer and touch-target affordances", () => {
  const nav = src("src/components/ChatbotWorkspaceNav.tsx");
  assert.match(nav, /usePathname/);
  assert.match(nav, /aria-current=\{active \? "page"/);
  assert.match(nav, /aria-label="Open Flowbot navigation"/);
  assert.match(nav, /role="dialog"/);
  assert.doesNotMatch(nav, /aria-modal="true"/);
  assert.match(nav, /ModalPortal/);
  assert.match(nav, /event\.key === "Escape"/);
  assert.match(nav, /min-h-11/);
  assert.match(nav, /sticky top-4/);
});

test("chatbot, flow library and analytics reuse one shared workspace shell", () => {
  for (const layout of [
    "src/app/(app)/chatbot/layout.tsx",
    "src/app/(app)/bot-builder/layout.tsx",
    "src/app/(app)/bot-analytics/layout.tsx",
  ]) {
    const source = src(layout);
    assert.match(source, /ChatbotWorkspaceNav/);
    assert.match(source, /min-w-0 flex-1/);
  }
});

test("individual flow workspace preserves tenant-scoped flow context", () => {
  const layout = src("src/app/(app)/bot-builder/[id]/layout.tsx");
  assert.match(layout, /const scope = await flowScope\(\)/);
  assert.match(layout, /findFirst\(\{ where: \{ id, \.\.\.scope \}/);
  assert.match(layout, /Current flow/);
  assert.match(layout, /flow\.name/);
  assert.match(layout, /flow\.channel/);
  assert.match(layout, /flow\.active \? "Live" : "Draft"/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("Flowbot workspace navigation covers all top-level surfaces in grouped horizontal clusters", () => {
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
  assert.match(nav, /Answer preview/);
  assert.doesNotMatch(nav, /label: "Simulator"/);
  assert.match(src("src/app/(app)/chatbot/preview/page.tsx"), /title="Answer preview"/);
  assert.match(nav, /label: "Configure"/);
  assert.match(nav, /label: "Test"/);
  assert.match(nav, /label: "Operate"/);
  assert.match(nav, /workspaceGroups\.map/);
  assert.doesNotMatch(nav, /<aside/);
});

test("Flowbot horizontal navigation restores a distinct icon for every tool", () => {
  const nav = src("src/components/ChatbotWorkspaceNav.tsx");
  for (const icon of ["Bot", "GitBranch", "Route", "BookOpen", "FlaskConical", "Inbox", "BarChart3"]) {
    assert.match(nav, new RegExp(`icon: ${icon}\\b`));
  }
  assert.match(nav, /<Icon className=\{`size-4 shrink-0/);
});

test("flow-specific simulator and evaluation tools remain owned by the flow workspace", () => {
  const layout = src("src/app/(app)/bot-builder/[id]/layout.tsx");
  assert.match(layout, /Simulator/);
  assert.match(layout, /Evaluations/);
  assert.match(layout, /\/bot-builder\/\$\{encoded\}\/test/);
  assert.match(layout, /\/bot-builder\/\$\{encoded\}\/evaluations/);
});

test("workspace navigation remains a compact top bar with responsive mobile disclosure", () => {
  const nav = src("src/components/ChatbotWorkspaceNav.tsx");
  assert.match(nav, /usePathname/);
  assert.match(nav, /aria-current=\{active \? "page"/);
  assert.match(nav, /aria-label=\{mobileOpen \? "Close Flowbot navigation" : "Open Flowbot navigation"\}/);
  assert.match(nav, /aria-expanded=\{mobileOpen\}/);
  assert.match(nav, /min-h-11/);
  assert.match(nav, /md:min-h-8/);
  assert.match(nav, /border-b border-border\/70/);
  assert.match(nav, /overflow-x-auto/);
  assert.match(nav, /md:flex/);
  assert.match(nav, /border-primary\/30 bg-primary\/10 text-primary/);
  assert.match(nav, /border-l border-border\/60 pl-4/);
  assert.doesNotMatch(nav, /bg-primary text-primary-foreground shadow-sm/);
  assert.doesNotMatch(nav, /<aside/);
  assert.doesNotMatch(nav, /w-56/);
});

test("individual flow workspaces suppress global Flowbot navigation to protect canvas width", () => {
  const nav = src("src/components/ChatbotWorkspaceNav.tsx");
  assert.match(nav, /isFlowWorkspace/);
  assert.match(nav, /pathname\.startsWith\("\/bot-builder\/"\)/);
  assert.match(nav, /!pathname\.startsWith\("\/bot-builder\/routes"\)/);
  assert.match(nav, /if \(isFlowWorkspace\) return null/);
});

test("chatbot, flow library and analytics reuse one full-width workspace shell", () => {
  for (const layout of [
    "src/app/(app)/chatbot/layout.tsx",
    "src/app/(app)/bot-builder/layout.tsx",
    "src/app/(app)/bot-analytics/layout.tsx",
  ]) {
    const source = src(layout);
    assert.match(source, /ChatbotWorkspaceNav/);
    assert.match(source, /<div className="min-w-0">/);
    assert.doesNotMatch(source, /lg:flex/);
    assert.doesNotMatch(source, /lg:gap-5/);
  }
});

test("individual flow workspace preserves tenant-scoped flow context in the focused toolbar", () => {
  const layout = src("src/app/(app)/bot-builder/[id]/layout.tsx");
  assert.match(layout, /const scope = await flowScope\(\)/);
  assert.match(layout, /findFirst\(\{ where: \{ id, \.\.\.scope \}/);
  assert.match(layout, /Current flow/);
  assert.match(layout, /flow\.name/);
  assert.match(layout, /flow\.channel/);
  assert.match(layout, /flow\.active \? "Live" : "Draft"/);
  assert.match(layout, /<ArrowLeft/);
  assert.match(layout, />Flows<\/Link>/);
});

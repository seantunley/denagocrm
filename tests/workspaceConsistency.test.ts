import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");

const redesignedWorkspaces = [
  "contacts",
  "deliveries",
  "document-studio",
  "fleets",
  "jobcards",
  "parts",
  "service-due",
  "signatures",
  "stock",
  "surveys",
  "targets",
  "vehicles",
  "warranty",
] as const;

test("named operational workspaces use the shared metrics-led hero", () => {
  for (const workspace of redesignedWorkspaces) {
    const source = read("src", "app", "(app)", workspace, "page.tsx");
    assert.match(source, /<WorkspaceHero/, `${workspace} should render WorkspaceHero`);
    assert.doesNotMatch(source, /<PageHeader/, `${workspace} should not retain the legacy PageHeader`);
  }
});

test("workshop insight and configuration screens use the same hierarchy", () => {
  for (const parts of [["jobcards", "insights"], ["settings", "workshop"]] as const) {
    const source = read("src", "app", "(app)", ...parts, "page.tsx");
    assert.match(source, /<WorkspaceHero/);
    assert.doesNotMatch(source, /<PageHeader/);
  }
});

test("workshop calendar and social inbox retain their existing shared hero", () => {
  const calendar = read("src", "components", "CalendarWorkspace.tsx");
  const inbox = read("src", "app", "(app)", "inbox", "page.tsx");
  assert.match(calendar, /<WorkspaceHero/);
  assert.match(inbox, /<WorkspaceHero/);
});

test("the shared workspace hero keeps its visual system in a compact footprint", () => {
  const hero = read("src", "components", "workspace-hero.tsx");

  assert.match(hero, /p-3\.5 sm:px-4 sm:py-3\.5/);
  assert.match(hero, /xl:flex xl:items-center xl:gap-4/);
  assert.match(hero, /mt-2\.5 grid grid-cols-2/);
  assert.match(hero, /px-2\.5 py-1\.5 backdrop-blur-sm/);
  assert.doesNotMatch(hero, /sm:p-6|mt-6 grid/);
});

test("shared workspace primitives enforce the compact density contract", () => {
  const globalCss = read("src", "app", "globals.css");
  const visualSystem = read("src", "components", "visual-system.tsx");
  const detailShell = read("src", "components", "entity-detail-shell.tsx");
  const captureForm = read("src", "components", "capture-form.tsx");
  const mobileWorkspace = read("src", "components", "mobile-workspace.tsx");

  const buttonRule = globalCss.match(/\.btn,\s*[\s\S]*?\.btn-danger \{([\s\S]*?)\n  \}/)?.[1] ?? "";
  const smallButtonRule = globalCss.match(/\.btn-sm \{([\s\S]*?)\n  \}/)?.[1] ?? "";
  const inputRule = globalCss.match(/\.input \{([\s\S]*?)\n  \}/)?.[1] ?? "";

  assert.match(buttonRule, /min-h-9/);
  assert.doesNotMatch(buttonRule, /(?:^|\s)h-9(?:\s|$)/);
  assert.match(smallButtonRule, /min-h-7/);
  assert.match(inputRule, /min-h-9/);
  assert.doesNotMatch(inputRule, /(?:^|\s)h-9(?:\s|$)/);
  assert.match(globalCss, /rounded-xl border border-white\/\[0\.075\] bg-card p-4/);
  assert.match(globalCss, /px-3 py-2\.5/);
  assert.match(visualSystem, /rounded-xl border border-border bg-card p-3/);
  assert.match(detailShell, /space-y-4/);
  assert.match(captureForm, /grid gap-3\.5 p-3\.5/);
  assert.match(mobileWorkspace, /min-h-9/);
});

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

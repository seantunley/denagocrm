import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");
const menuSource = read("src", "components", "RecordContextMenu.tsx");
const quickCreateSource = read("src", "components", "QuickCreateDialog.tsx");
const quickCreateRouteSource = read("src", "app", "api", "quick-create", "route.ts");

const coveredSurfaces = [
  ["contacts", "page.tsx"],
  ["leads", "list", "page.tsx"],
  ["quotes", "page.tsx"],
  ["vehicles", "page.tsx"],
  ["jobcards", "page.tsx"],
  ["stock", "page.tsx"],
  ["products", "page.tsx"],
  ["fleets", "page.tsx"],
  ["cases", "page.tsx"],
  ["campaigns", "page.tsx"],
  ["surveys", "page.tsx"],
  ["competitors", "page.tsx"],
  ["signatures", "page.tsx"],
] as const;

test("record context menu provides consistent open and copy-link commands", () => {
  assert.match(menuSource, /Open in new tab/);
  assert.match(menuSource, /Copy link/);
  assert.match(menuSource, /navigator\.clipboard\.writeText/);
  assert.match(menuSource, /openQuickCreate\([\s\S]+action\.quickCreate/);
});

test("contact record actions preserve the selected contact", () => {
  assert.match(menuSource, /href\.match\(\/\^\\\/contacts\\\/\(\[\^\/?#\]\+\)\//);
  assert.match(menuSource, /contactId: decodeURIComponent\(match\[1\]\)/);
  assert.match(menuSource, /contactLabel: label/);
  assert.match(quickCreateSource, /defaults=\{\{[\s\S]+contactId: createDefaults\.contactId/);
  assert.match(quickCreateSource, /defaultValue=\{createDefaults\.contactId \?\? ""\}/);
});

test("record quick-create staff options stay inside the active tenant", () => {
  assert.match(quickCreateRouteSource, /listTenantStaff\(\)/);
  assert.doesNotMatch(quickCreateRouteSource, /prisma\.user\.findMany/);
});

test("primary record surfaces use the shared context menu", () => {
  for (const path of coveredSurfaces) {
    const source = read("src", "app", "(app)", ...path);
    assert.match(source, /RecordContextMenu/, `${path.join("/")} should expose record actions`);
  }
  assert.match(read("src", "components", "RepoRow.tsx"), /RecordContextMenu/);
});

test("record-specific workflows are surfaced where they exist", () => {
  assert.match(read("src", "app", "(app)", "contacts", "page.tsx"), /Schedule activity/);
  assert.match(read("src", "app", "(app)", "leads", "list", "page.tsx"), /Edit lead/);
  assert.match(read("src", "app", "(app)", "quotes", "page.tsx"), /Print \/ PDF/);
  assert.match(read("src", "app", "(app)", "vehicles", "page.tsx"), /job card/);
  assert.match(read("src", "app", "(app)", "jobcards", "page.tsx"), /Print job card/);
  assert.match(read("src", "app", "(app)", "stock", "page.tsx"), /Open linked quote/);
});

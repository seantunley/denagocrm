import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");

test("marketing uses the shared workspace header and keeps navigation inside it", () => {
  const marketing = source("src", "components", "marketing", "MarketingWorkspaceShell.tsx");

  assert.match(marketing, /<WorkspaceHero/);
  assert.match(marketing, /tone="marketing"/);
  assert.match(marketing, /navigation=\{/);
  assert.doesNotMatch(marketing, /<section className="relative overflow-hidden rounded-2xl/);
});

test("shared surfaces expose a deliberate three-level hierarchy", () => {
  const visualSystem = source("src", "components", "visual-system.tsx");

  assert.match(visualSystem, /level\?: "raised" \| "base" \| "inset"/);
  assert.match(visualSystem, /data-level=\{resolvedLevel\}/);
  assert.match(visualSystem, /raised: "bg-card shadow-/);
  assert.match(visualSystem, /inset: "bg-background\/35"/);
});

test("status and empty states use quiet content-first presentation", () => {
  const visualSystem = source("src", "components", "visual-system.tsx");
  const status = visualSystem.match(/data-slot="status-pill"[\s\S]*?\{children\}/)?.[0] ?? "";
  const empty = visualSystem.match(/export function EmptyState[\s\S]*?export function StatusPill/)?.[0] ?? "";

  assert.match(status, /text-\[11px\] font-medium/);
  assert.doesNotMatch(status, /uppercase|tracking-/);
  assert.doesNotMatch(empty, /border-dashed/);
});

test("page skeletons mirror the compact surface system", () => {
  const visualSystem = source("src", "components", "visual-system.tsx");
  const skeletons = visualSystem.match(/export function PageSkeleton[\s\S]*$/)?.[0] ?? "";

  assert.match(skeletons, /<Skeleton/);
  assert.match(skeletons, /data-slot="page-skeleton"/);
  assert.match(skeletons, /aria-busy="true"/);
  assert.doesNotMatch(skeletons, /rounded-2xl|animate-pulse/);
});

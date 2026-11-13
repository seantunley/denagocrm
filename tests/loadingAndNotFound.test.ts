import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** ui-ux-upgrade-plan.md 1.1 / 1.2 (Sean, 2026-11-13: "Yes"). */
test("the busiest sections that had only the generic loading screen now have one shaped like the page", () => {
  const shaped: Record<string, string> = {
    calendar: "calendar", "workshop-calendar": "calendar", deliveries: "board",
    invoices: "list", activities: "list", products: "list", "test-drives": "list", documents: "list", notifications: "list", search: "list",
  };
  for (const [section, variant] of Object.entries(shaped)) {
    const file = `src/app/(app)/${section}/loading.tsx`;
    assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), file);
    assert.match(src(file), new RegExp(`<PageSkeleton variant="${variant}" />`), file);
  }
  const system = src("src/components/visual-system.tsx");
  assert.match(system, /variant === "calendar"/);
  assert.match(system, /variant === "board"/);
  assert.match(system, /aria-busy="true" role="status"/, "announced as loading");
});

test("not found keeps the sidebar inside the app, and stays neutral for customers outside it", () => {
  assert.match(src("src/app/(app)/not-found.tsx"), /<NotFoundScreen inApp \/>/);
  assert.match(src("src/app/not-found.tsx"), /<NotFoundScreen inApp=\{false\} \/>/);
  const screen = src("src/components/NotFoundScreen.tsx");
  // Search and "the dashboard" only inside the app: signing, handover and approval links land at the root.
  const neutral = screen.slice(0, screen.indexOf("{inApp && ("));
  assert.doesNotMatch(neutral, /action="\/search"|Back to the dashboard/);
  assert.match(screen, /\{inApp && \([\s\S]*action="\/search"[\s\S]*Back to the dashboard/);
  assert.match(screen, /Trash for 60 days/);
});

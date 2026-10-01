import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

// Batch 6: the old single-pipeline stage editor in Settings was a second copy of
// /settings/pipelines. One editor now; old ?tab=pipeline links land on it.

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("Settings no longer renders its own stage editor", () => {
  const page = src("src/app/(app)/settings/page.tsx");
  assert.doesNotMatch(page, /tab === "pipeline"/);
  assert.doesNotMatch(page, /renameStage|createStage|deleteStage/);
  assert.match(page, /if \(requestedTab === "pipeline"\) redirect\("\/settings\/pipelines"\);/);
});

test("the menu entry already points at the one editor", () => {
  assert.match(src("src/lib/settings-navigation.ts"), /\{ key: "pipeline", label: "Pipeline", href: "\/settings\/pipelines"/);
});

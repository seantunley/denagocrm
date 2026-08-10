import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");

test("legacy and component controls share the modern interaction contract", () => {
  const globalCss = source("src", "app", "globals.css");
  const button = source("src", "components", "ui", "button.tsx");
  const input = source("src", "components", "ui", "input.tsx");

  const legacyButtons = globalCss.match(/\.btn,\s*[\s\S]*?\.btn-danger \{([\s\S]*?)\n  \}/)?.[1] ?? "";
  const legacyInput = globalCss.match(/\.input \{([\s\S]*?)\n  \}/)?.[1] ?? "";

  for (const control of [legacyButtons, button, legacyInput, input]) {
    assert.match(control, /rounded-lg/);
    assert.match(control, /min-h-9/);
  }

  assert.doesNotMatch(legacyButtons, /transition-all|hover:-translate/);
  assert.doesNotMatch(button, /transition-all|hover:-translate/);
  assert.doesNotMatch(input, /(?:^|\s)h-9(?:\s|$)/);
});

test("small interface labels remain compact without becoming display typography", () => {
  const globalCss = source("src", "app", "globals.css");
  const label = source("src", "components", "ui", "label.tsx");
  const legacyLabel = globalCss.match(/\.label \{([\s\S]*?)\n  \}/)?.[1] ?? "";
  const tableHeader = globalCss.match(/\.table-base th \{([\s\S]*?)\n  \}/)?.[1] ?? "";

  assert.match(legacyLabel, /text-xs/);
  assert.doesNotMatch(legacyLabel, /uppercase|text-\[10px\]/);
  assert.match(label, /text-xs/);
  assert.match(tableHeader, /text-\[11px\]/);
  assert.doesNotMatch(tableHeader, /uppercase/);
});

test("workspace motion is reserved for meaningful interactions", () => {
  const globalCss = source("src", "app", "globals.css");

  assert.doesNotMatch(globalCss, /\.denago-workspace > \*\s*\{[\s\S]*?animation:/);
  assert.doesNotMatch(globalCss, /@keyframes workspace-enter/);
  assert.match(globalCss, /@media \(prefers-reduced-motion: reduce\)/);
});

test("the shared textarea is multiline by construction", () => {
  const textarea = source("src", "components", "ui", "textarea.tsx");

  assert.match(textarea, /min-h-20/);
  assert.match(textarea, /resize-y/);
  assert.doesNotMatch(textarea, /(?:^|\s)h-9(?:\s|$)/);
});

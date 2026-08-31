import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("every flow workspace exposes the new draft/version/block/analytics tools", () => {
  const layout = src("src/app/(app)/bot-builder/[id]/layout.tsx");
  assert.match(layout, /Flow tools/);
  assert.match(layout, /Draft/);
  assert.match(layout, /Versions/);
  assert.match(layout, /Reusable blocks/);
  assert.match(layout, /Analytics/);
  assert.match(layout, /\/bot-analytics\?flowId=/);
});

test("chatbot settings, knowledge and AI preview are mutually discoverable", () => {
  const nav = src("src/components/ChatbotWorkspaceNav.tsx");
  assert.match(nav, /href: "\/chatbot"/);
  assert.match(nav, /href: "\/chatbot\/knowledge"/);
  assert.match(nav, /href: "\/chatbot\/preview"/);
  assert.match(nav, /href: "\/bot-builder"/);
  assert.match(nav, /href: "\/bot-builder\/routes"/);
});

test("tool navigation is implemented as nested route layouts rather than duplicated page controls", () => {
  assert.match(src("src/app/(app)/bot-builder/[id]/layout.tsx"), /\{children\}/);
  assert.match(src("src/app/(app)/chatbot/layout.tsx"), /\{children\}/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("preview is owner-only and invokes the production answer decision", () => {
  const action = src("src/app/actions/botPreview.ts");
  assert.match(action, /await requireOwner\(\)/);
  assert.match(action, /generateBotReply\(/);
  assert.match(action, /history: \[\{ role: "user", content: question \}\]/);
});

test("preview action has no customer, booking, lead or session writes", () => {
  const action = src("src/app/actions/botPreview.ts");
  assert.doesNotMatch(action, /prisma\./);
  assert.doesNotMatch(action, /runFlow|advanceFlow|reserveSlot|createIntakeLead|sendWhatsApp|sendDirect|tgSend|putSetting/);
});

test("preview shows confidence, intent and staff handoff context", () => {
  const ui = src("src/components/BotAiPreviewConsole.tsx");
  assert.match(ui, /confidence/);
  assert.match(ui, /intent:/);
  assert.match(ui, /Human handoff context/);
  assert.match(ui, /Staff summary/);
  assert.match(ui, /stays automated/);
});

test("preview exposes only approved/current knowledge matches", () => {
  const action = src("src/app/actions/botPreview.ts");
  assert.match(action, /searchBotKnowledge\(question\)/);
  const ui = src("src/components/BotAiPreviewConsole.tsx");
  assert.match(ui, /Approved Knowledge matched/);
});

test("preview page states that it is read-only but consumes a real inference", () => {
  const page = src("src/app/(app)/chatbot/preview/page.tsx");
  assert.match(page, /Read-only/);
  const ui = src("src/components/BotAiPreviewConsole.tsx");
  assert.match(ui, /does consume one normal AI inference/);
  assert.match(ui, /production decision path/);
});

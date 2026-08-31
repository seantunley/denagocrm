import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(`${process.cwd()}/${path}`, "utf8");

test("routing workspace can preview first-match behavior", async () => {
  const page = await read("src/app/(app)/bot-builder/routes/page.tsx");
  const tester = await read("src/components/FlowRouteTester.tsx");
  assert.match(page, /FlowRouteTester/);
  assert.match(tester, /routeMatches/);
  assert.match(tester, /Test current routing/);
  assert.match(tester, /channel default will be used/);
});

test("routing table exposes target flow version context", async () => {
  const source = await read("src/app/(app)/bot-builder/routes/page.tsx");
  assert.match(source, /latestVersionByFlow/);
  assert.match(source, /route pinned older/);
  assert.match(source, /bot-builder\/\$\{route\.flowId\}/);
});

test("knowledge workspace filters by source and sort order", async () => {
  const source = await read("src/app/(app)/chatbot/knowledge/page.tsx");
  assert.match(source, /knowledge-source/);
  assert.match(source, /knowledge-sort/);
  assert.match(source, /Recently updated/);
  assert.match(source, /Library sourced/);
  assert.match(source, /Preview AI use/);
});

test("handoff queue exposes reason wait time assignment and takeover before opening thread", async () => {
  const source = await read("src/components/BotHandoffQueue.tsx");
  assert.match(source, /waitLabel/);
  assert.match(source, /item\.reason/);
  assert.match(source, /Assign to/);
  assert.match(source, /assignConversation/);
  assert.match(source, /setConversationBotMode\(item\.conversationId, "human"\)/);
  assert.match(source, /SLA overdue/);
});

test("inbox handoff tab separates waiting and human handling", async () => {
  const source = await read("src/app/(app)/inbox/page.tsx");
  assert.match(source, /Waiting for takeover/);
  assert.match(source, /Human handling/);
  assert.match(source, /BotHandoffQueue/);
  assert.match(source, /overdueHandoffs/);
});

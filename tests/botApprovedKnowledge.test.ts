import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("knowledge retrieval can use only approved entries inside their validity window", () => {
  const code = src("src/lib/botKnowledge.ts");
  assert.match(code, /entry\.status !== "approved"/);
  assert.match(code, /entry\.validFrom && new Date\(entry\.validFrom\) > now/);
  assert.match(code, /entry\.validUntil && new Date\(entry\.validUntil\) < now/);
  const retrieval = code.slice(code.indexOf("export function retrieveRelevantKnowledge"));
  assert.match(retrieval, /filter\(\(entry\) => knowledgeIsCurrent\(entry, now\)\)/);
  assert.match(retrieval, /slice\(0, limit\)/);
});

test("new knowledge is always a draft and approval is a separate owner action", () => {
  const code = src("src/app/actions/bot.ts");
  const addAt = code.indexOf("export async function addBotKnowledge");
  const statusAt = code.indexOf("export async function setBotKnowledgeStatus");
  assert.ok(addAt >= 0 && statusAt > addAt);
  const add = code.slice(addAt, statusAt);
  assert.match(add, /await requireOwner\(\)/);
  assert.match(add, /status: "draft"/);
  assert.doesNotMatch(add, /status: "approved"/);
  const status = code.slice(statusAt, code.indexOf("export async function deleteBotKnowledge"));
  assert.match(status, /await requireOwner\(\)/);
  assert.match(status, /approvedAt: now/);
  assert.match(status, /approvedBy: owner\.name/);
});

test("library files are provenance only; their bytes are never automatically trusted", () => {
  const actions = src("src/app/actions/bot.ts");
  const add = actions.slice(actions.indexOf("export async function addBotKnowledge"), actions.indexOf("export async function setBotKnowledgeStatus"));
  assert.match(add, /prisma\.libraryDocument\.findUnique/);
  assert.match(add, /sourceLabel = document\.name/);
  assert.doesNotMatch(add, /readFile\(|extract|pdf|arrayBuffer/);

  const knowledge = src("src/lib/botKnowledge.ts");
  assert.match(knowledge, /sourceType: "manual" \| "library"/);
  assert.doesNotMatch(knowledge, /readFile\(|fetch\(/);
});

test("assistant retrieves from the latest customer question and labels the source as approved knowledge", () => {
  const code = src("src/lib/botAi.ts");
  assert.match(code, /const latestQuestion = \[\.\.\.input\.history\]\.reverse\(\)\.find\(\(message\) => message\.role === "user"\)\?\.content/);
  assert.match(code, /retrieveRelevantKnowledge\(knowledgeEntries, latestQuestion\)/);
  assert.match(code, /APPROVED KNOWLEDGE RETRIEVED FOR THIS QUESTION/);
  assert.match(code, /Treat only KNOWN LIVE BUSINESS FACTS, LIVE PRODUCT FACTS, the APPROVED KNOWLEDGE block, and exact FAQ answers as factual sources/);
});

test("chatbot settings expose draft, approve and expire states instead of one-click publication", () => {
  const page = src("src/app/(app)/chatbot/page.tsx");
  assert.match(page, /\+ Add knowledge draft/);
  assert.match(page, /Add draft/);
  assert.match(page, /Approve/);
  assert.match(page, /Expire/);
  assert.match(page, /Return to draft/);
  assert.match(page, /New entries are always Draft/);
});

test("knowledge entries remain in tenant-scoped settings and therefore existing backup coverage", () => {
  const knowledge = src("src/lib/botKnowledge.ts");
  const actions = src("src/app/actions/bot.ts");
  assert.match(knowledge, /getSetting\("BOT_KNOWLEDGE_ENTRIES"\)/);
  assert.match(actions, /putSetting\("BOT_KNOWLEDGE_ENTRIES"/);
});

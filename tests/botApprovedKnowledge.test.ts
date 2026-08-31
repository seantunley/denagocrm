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
  assert.match(add, /botKnowledgeEntry\.create/);
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
  assert.match(actions, /prisma\.libraryDocument\.findFirst/);
  assert.match(actions, /where: \{ id: sourceDocumentId, tenantId \}/);
  assert.match(actions, /sourceLabel: document\.name/);
  assert.doesNotMatch(add, /readFile\(|extract|pdf|arrayBuffer/);

  const knowledge = src("src/lib/botKnowledge.ts");
  assert.match(knowledge, /sourceType: "manual" \| "library"/);
  assert.doesNotMatch(knowledge, /readFile\(|fetch\(/);
});

test("assistant retrieves from the latest customer question and labels the source as approved knowledge", () => {
  const code = src("src/lib/botAi.ts");
  assert.match(code, /const latestQuestion = \[\.\.\.input\.history\]\.reverse\(\)\.find\(\(message\) => message\.role === "user"\)\?\.content/);
  assert.match(code, /searchBotKnowledge\(latestQuestion\)/);
  assert.match(code, /APPROVED KNOWLEDGE RETRIEVED FOR THIS QUESTION/);
  assert.match(code, /Treat only KNOWN LIVE BUSINESS FACTS, LIVE PRODUCT FACTS, the APPROVED KNOWLEDGE block, and exact FAQ answers as factual sources/);
});

test("chatbot settings expose draft, approve and expire states instead of one-click publication", () => {
  const page = src("src/app/(app)/chatbot/knowledge/page.tsx");
  assert.match(page, /Add knowledge draft/);
  assert.match(page, /Add draft/);
  assert.match(page, /Approve/);
  assert.match(page, /Expire/);
  assert.match(page, /Return to draft/);
  assert.match(page, /New entries are always Draft/);
  assert.match(page, /Saving an edit returns this entry to Draft/);
});

test("knowledge is database-backed, tenant-qualified and automatically covered by portable backup", () => {
  const knowledge = src("src/lib/botKnowledge.ts");
  const actions = src("src/app/actions/bot.ts");
  const schema = src("prisma/schema.prisma");
  const migration = src("prisma/migrations/20260830213000_bot_knowledge_workspace/migration.sql");
  assert.match(schema, /model BotKnowledgeEntry/);
  assert.match(knowledge, /where: \{ tenantId \}/);
  assert.match(actions, /where: \{ id, tenantId \}/);
  assert.doesNotMatch(knowledge, /getSetting\("BOT_KNOWLEDGE_ENTRIES"\)/);
  assert.doesNotMatch(actions, /putSetting\("BOT_KNOWLEDGE_ENTRIES"/);
  assert.match(migration, /BotKnowledgeEntry_tenant_isolation/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(src("src/lib/backup.ts"), /information_schema\.tables/);
});

test("retrieval combines indexed full-text rank with deterministic phrase and token scoring", () => {
  const knowledge = src("src/lib/botKnowledge.ts");
  const migration = src("prisma/migrations/20260830213000_bot_knowledge_workspace/migration.sql");
  assert.match(migration, /BotKnowledgeEntry_search_idx/);
  assert.match(migration, /to_tsvector\('simple'/);
  assert.match(knowledge, /ts_rank_cd/);
  assert.match(knowledge, /ftsRank \* 20/);
  assert.match(knowledge, /normalized\(entry\.title\)\.includes\(queryPhrase\)/);
  assert.match(knowledge, /slice\(0, limit\)/);
});

test("editing a live fact cannot silently change customer-facing knowledge", () => {
  const actions = src("src/app/actions/bot.ts");
  const edit = actions.slice(actions.indexOf("export async function updateBotKnowledge"), actions.indexOf("export async function setBotKnowledgeStatus"));
  assert.match(edit, /await requireOwner\(\)/);
  assert.match(edit, /status: "draft"/);
  assert.match(edit, /approvedAt: null/);
  assert.match(edit, /approvedBy: null/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { cleanTitle, snippet, TITLE_MAX, TRASH_DAYS } from "../src/lib/assistantConversationRules";
import { SOFT_DELETE_MODELS } from "../src/lib/softDeleteModels";
import { daxCore } from "./daxCore";

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** Sean, 2026-11-14: "Search and manage conversations. I found no search across past conversations, and no rename or delete." */

test("a typed name is cleaned and capped like the automatic ones; blank is no name", () => {
  assert.equal(cleanTitle("  Anna   — Rover XL \n quote "), "Anna — Rover XL quote");
  assert.equal(cleanTitle("   "), "");
  assert.equal(cleanTitle(null), "");
  const long = cleanTitle("x".repeat(200));
  assert.equal(long.length, TITLE_MAX);
  assert.ok(long.endsWith("…"));
});

test("a search result shows the words around where it matched, any case", () => {
  const text = `${"before ".repeat(20)}the Rover XL for Anna${" after".repeat(20)}`;
  const s = snippet(text, "rover xl", 20);
  assert.match(s, /^….*Rover XL.*…$/);
  assert.ok(s.length < 70);
  assert.equal(snippet("Short answer", "short"), "Short answer", "nothing cut, no dots");
  assert.equal(snippet("x".repeat(300), "nope", 10), `${"x".repeat(20)}…`, "no match: the start");
});

test("deleted conversations are soft-deleted, registered, and gone from every conversation read", () => {
  assert.ok(SOFT_DELETE_MODELS.has("AssistantConversation"));
  assert.equal(TRASH_DAYS, 60);
  const migration = src("prisma/migrations/20261114210000_assistant_conversation_deleted_at/migration.sql");
  assert.match(migration, /^ALTER TABLE "AssistantConversation" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP\(3\);$/m, "additive only");
  assert.doesNotMatch(migration, /DROP|DELETE|UPDATE/);
  // Every live read and write of a conversation in the library names deletedAt: null (the guarded client adds it
  // too; this does not lean on that).
  const lib = src("src/lib/assistantConversation.ts");
  const reads = [...lib.matchAll(/assistantConversation\.(findFirst|findMany|updateMany)\(/g)].map((m) => lib.slice(m.index, m.index + 260));
  assert.ok(reads.length >= 11, String(reads.length));
  for (const r of reads) assert.match(r, /deletedAt: (null|\{)/, r);
});

test("search: the person's OWN live conversations only, bounded, newest first", () => {
  const lib = src("src/lib/assistantConversation.ts");
  const search = lib.slice(lib.indexOf("export async function searchConversations"), lib.indexOf("/** What DAX sent on its own"));
  assert.match(search, /if \(q\.length < 2\) return \[\];/);
  assert.equal((search.match(/where: \{ tenantId: who\.tenantId, userId: who\.userId,/g) ?? []).length, 3, "all three queries name the workspace and the person");
  // One matching turn per live conversation, so a busy conversation can't crowd an older match out (review of #1115).
  assert.match(search, /AND: \[live, \{ OR: \[\{ question: has \}, \{ answer: has \}\] \}\] \},\s*orderBy: \{ createdAt: "desc" \},\s*distinct: \["conversationId"\],\s*take: SEARCH_RESULTS,/);
  assert.match(search, /const live = await liveTurnsWhere\(who\.tenantId, who\.userId\);/);
  assert.match(search, /\.sort\(\(a, b\) => b\.updatedAt\.getTime\(\) - a\.updatedAt\.getTime\(\)\)\s*\.slice\(0, SEARCH_RESULTS\)/);
});

test("?c=<id> opens that conversation even beyond the 20 recent chips — only the person's own, live (review of #1115)", () => {
  const lib = src("src/lib/assistantConversation.ts");
  assert.match(lib, /export async function liveConversation\(who: Who, id: string\) \{\s*return prisma\.assistantConversation\.findFirst\(\{\s*where: \{ id, tenantId: who\.tenantId, userId: who\.userId, deletedAt: null \},/);
  const page = src("src/app/(app)/assistant/page.tsx");
  assert.match(page, /c && !special \? liveConversation\(who, c\) : Promise\.resolve\(null\)/);
  assert.match(page, /const picked = special && c \? c : asked\?\.id \?\? defaultConversation\(recent\);/);
});

test("rename, delete and restore: by id AND person AND workspace, audited without the title, time kept", () => {
  const actions = src("src/app/actions/assistantConversations.ts");
  assert.match(actions, /where: \{\s*id: String\(id\),\s*userId,\s*tenantId: ownedWriteTenantId\(\),/);
  for (const name of ["renameAssistantConversation", "deleteAssistantConversation", "restoreAssistantConversation"]) {
    const body = actions.slice(actions.indexOf(`export async function ${name}`)).split("\nexport async function ")[0];
    assert.match(body, /withActingStaffScope\(async \(\) => \{\s*const user = await gate\(\);/, `${name} binds the workspace and gates first`);
    assert.match(body, /await ownConversation\(id, user\.id, (true|false)\)/, `${name} checks the row is theirs`);
    assert.match(body, /where: \{ id: conversation\.id, tenantId: conversation\.tenantId, userId: user\.id,/);
    assert.match(body, /updatedAt: conversation\.updatedAt/, `${name} doesn't move it to the top or make it the current one`);
    assert.match(body, /logAudit\(\{ action: "assistant\.conversation_\w+", summary: "\w+ an assistant conversation"/, "never a hard-coded assistant name: a workspace may rename it");
  }
});

test("DAX stops remembering a deleted conversation: recall, recent turns and the nightly tidy-up skip it", () => {
  const ask = daxCore(src);
  assert.match(ask, /AND NOT EXISTS \(SELECT 1 FROM "AssistantConversation" c WHERE c\."id" = "AssistantTurn"\."conversationId" AND c\."deletedAt" IS NOT NULL\)/);
  assert.equal((ask.match(/AND: \[live\]/g) ?? []).length, 3, "the turns around a recalled one, and recent turns");
  const tidy = src("src/lib/assistantTidy.ts");
  assert.equal((tidy.match(/AND: \[live\]/g) ?? []).length, 2);
  const lib = src("src/lib/assistantConversation.ts");
  // The NULL case named: a NOT IN alone would drop every turn that belongs to no conversation.
  assert.match(lib, /\{ OR: \[\{ conversationId: null \}, \{ conversationId: \{ notIn: gone\.map\(\(c\) => c\.id\) \} \}\] \}/);
});

test("after 60 days the nightly purge removes the conversation and its exchanges together", () => {
  const trash = src("src/lib/trash.ts");
  const purge = trash.slice(trash.indexOf("// DAX conversations their person deleted"));
  assert.match(purge, /WHERE "deletedAt" < \$\{cutoff\} LIMIT 500 FOR UPDATE/);
  assert.ok(purge.indexOf("tx.assistantTurn.deleteMany") < purge.indexOf("tx.assistantConversation.deleteMany"));
});

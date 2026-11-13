import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { chatQueue, emptyChatQueue } from "../src/components/chatQueue";

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** Sean, 2026-11-13: "I found no way to edit your last question and ask again." */
test("a corrected question carries the one it replaces through the queue", () => {
  const asked = chatQueue(emptyChatQueue<Blob>(), { type: "ask", text: "Which deals are stuck?", replaces: "cmturn0000000000000000001" });
  assert.equal(asked.running?.replaces, "cmturn0000000000000000001");
  const plain = chatQueue(emptyChatQueue<Blob>(), { type: "ask", text: "Hello" });
  assert.equal("replaces" in (plain.running ?? {}), false, "an ordinary question replaces nothing");
});

test("only the person's own latest chat question, in this workspace, is taken out — and its waiting tasks withdrawn", () => {
  const edit = src("src/lib/assistantEdit.ts");
  assert.match(edit, /where: \{ tenantId, userId, source: "chat" \},\s*orderBy: \{ createdAt: "desc" \},\s*take: 2,/);
  assert.match(edit, /if \(!last \|\| last\.id !== turnId\) return false;/, "anything but the latest is refused");
  assert.match(edit, /tx\.assistantTurn\.deleteMany\(\{ where: \{ id: last\.id, tenantId, userId \} \}\)/);
  assert.match(edit, /tx\.assistantPendingAction\.updateMany\(\{[\s\S]*confirmedAt: null,[\s\S]*data: \{ expiresAt: now \}/, "nothing confirmable from an answer that is gone");
  assert.match(edit, /prisma\.\$transaction\(async \(tx\) =>/, "the callback form — the scoped client refuses an array transaction");

  const route = src("src/app/api/assistant/ask/route.ts");
  // After the retry check: a retried key follows the run it already started, and never withdraws twice.
  const retry = route.indexOf("if (key && claimed && !claimed.created) return ndjson");
  const withdraw = route.indexOf("await withdrawLastQuestion(tenantId, user.id, replaces)");
  assert.ok(retry > 0 && withdraw > retry, "withdrawn only for a new run");
  assert.ok(withdraw < route.indexOf("const result = await askAsPerson("), "before DAX reads its context");
});

test("the pencil is on the last question you asked here, and sending removes the old exchange from the screen", () => {
  const chat = src("src/components/AssistantChat.tsx");
  assert.match(chat, /index === 0 && !pending && chat\.queue\.length === 0 && Boolean\(turn\.turnId\) && !turn\.stopped && \(turn\.source \?\? "chat"\) === "chat"/);
  assert.match(chat, /form\.set\("replaces", item\.replaces\);\s*setTurns\(\(prev\) => prev\.filter\(\(turn\) => turn\.turnId !== item\.replaces\)\);/);
  assert.match(chat, /aria-label="Edit your question and ask again"/);
  assert.match(chat, /Editing your last question — send it to ask again; the old answer goes\./);
  // History loaded on open carries the id, so the last question is editable after a reload too.
  assert.match(src("src/lib/crmAssistant.ts"), /select: \{ id: true, question: true, answer: true, source: true \},/);
  assert.match(src("src/app/(app)/assistant/page.tsx"), /history=\{history\.map\(\(\{ id, question, answer, source \}\) => \(\{ id, question, answer, source \}\)\)\}/);
});

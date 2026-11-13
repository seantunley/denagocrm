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

test("only the person's own latest chat question is taken out — and only the plans IT offered are closed", () => {
  const edit = src("src/lib/assistantEdit.ts");
  assert.match(edit, /where: \{ tenantId, userId, source: "chat" \},\s*orderBy: \{ createdAt: "desc" \},\s*take: 1,/);
  assert.match(edit, /if \(!last \|\| last\.id !== turnId\) return "not-latest";/, "anything but the latest is refused");
  assert.match(edit, /tx\.assistantTurn\.deleteMany\(\{ where: \{ id: last\.id, tenantId, userId \} \}\)/);
  // Review of #1092: by the answer's own record of its plans — never a time window (that caught WhatsApp's cards).
  assert.match(edit, /where: \{ id: \{ in: planIds \}, tenantId, userId, kind: PLAN_KIND, status: "open" \}/);
  assert.doesNotMatch(edit, /assistantPendingAction|createdAt: \{ gt/, "nothing matched by time");
  assert.match(edit, /prisma\.\$transaction\(async \(tx\) =>/, "the callback form — the scoped client refuses an array transaction");
  assert.match(src("src/lib/crmAssistant.ts"), /actions\[i\]\.kind === "plan" \? \{ \.\.\.p, planId: actions\[i\]\.id\.replace\(\/\^plan-\/, ""\) \} : p/, "each answer records the plans it offered");

  const route = src("src/app/api/assistant/ask/route.ts");
  // After the retry check: a retried key follows the run it already started, and never withdraws twice.
  const retry = route.indexOf("if (key && claimed && !claimed.created) return ndjson");
  const withdraw = route.indexOf("await withdrawLastQuestion(tenantId, user.id, replaces)");
  assert.ok(retry > 0 && withdraw > retry, "withdrawn only for a new run");
  assert.ok(withdraw < route.indexOf("const result = await askAsPerson("), "before DAX reads its context");
  // A failed or refused withdrawal asks NOTHING, and says the old question is kept.
  assert.match(route, /if \(withdrawn !== "withdrawn"\) \{[\s\S]*kept: true,[\s\S]*send\(\{ t: "done", r: refused \}\);/);
  assert.ok(route.indexOf('if (withdrawn !== "withdrawn")') < route.indexOf("const result = await askAsPerson("));
});

test("offeredPlanIds reads only plans, by id", async () => {
  const src2 = src("src/lib/assistantEdit.ts");
  assert.match(src2, /export function offeredPlanIds\(proposed: unknown\): string\[\]/);
  // (The module is server-only; the real-database proof is scripts/test-assistant-edit.ts.)
  assert.match(src("package.json"), /"test:assistant-edit": "tsx --tsconfig tsconfig\.scripts\.json scripts\/test-assistant-edit\.ts"/);
  assert.match(src(".github/workflows/security-rbac-ci.yml"), /run: npm run test:assistant-edit/);
});

test("the pencil is on the last question you asked here, and sending removes the old exchange from the screen", () => {
  const chat = src("src/components/AssistantChat.tsx");
  assert.match(chat, /index === 0 && !pending && chat\.queue\.length === 0 && Boolean\(turn\.turnId\) && !turn\.stopped && \(turn\.source \?\? "chat"\) === "chat"/);
  assert.match(chat, /if \(item\.replaces\) form\.set\("replaces", item\.replaces\);/);
  // It leaves the screen only once the server took it out (kept: refused, nothing asked).
  assert.match(chat, /\.\.\.\(item\.replaces && !\(!result\.ok && result\.kept\) \? prev\.filter\(\(turn\) => turn\.turnId !== item\.replaces\) : prev\)/);
  assert.match(chat, /aria-label="Edit your question and ask again"/);
  assert.match(chat, /Editing your last question — send it to ask again; the old answer goes\./);
  // History loaded on open carries the id, so the last question is editable after a reload too.
  assert.match(src("src/lib/crmAssistant.ts"), /select: \{ id: true, question: true, answer: true, source: true \},/);
  assert.match(src("src/app/(app)/assistant/page.tsx"), /history=\{history\.map\(\(\{ id, question, answer, source \}\) => \(\{ id, question, answer, source \}\)\)\}/);
});

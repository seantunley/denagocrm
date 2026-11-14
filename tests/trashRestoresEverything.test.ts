import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";

// Gap audit #28: the trash could restore only 8 record types. Everything else
// staff can delete was soft-deleted (deletedAt set) and then simply hidden, with
// no way back.

const root = new URL("../", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, root), "utf8").replace(/\r\n/g, "\n");
const lib = read("src/lib/trash.ts");
const listed = (name: string) =>
  [...(lib.match(new RegExp(`export const ${name}: \\w+\\[\\] = \\[([\\s\\S]*?)\\];`))?.[1] ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1]);
const restorable = new Set([...listed("TRASH_MODELS"), ...listed("RESTORE_ONLY_MODELS")]);

/** Models an ACTION soft-deletes (`<client>.<model>.update…({… deletedAt: new Date()`). */
function softDeletedByActions(): Set<string> {
  const found = new Set<string>();
  for (const file of readdirSync(new URL("src/app/actions/", root))) {
    const src = read(`src/app/actions/${file}`);
    for (const m of src.matchAll(/(?:prisma|tx)\.(\w+)\.update(?:Many)?\(\{[^;]*?deletedAt: new Date\(\)/g)) found.add(m[1]);
  }
  return found;
}

/**
 * Restorable, but NOT from the workspace Trash: a DAX conversation is private to its person — not even the owner may
 * see it — so it waits under "Recently deleted" on that person's own Ask page (actions/assistantConversations.ts).
 */
const OWN_RESTORE: Record<string, string> = { assistantConversation: "src/app/actions/assistantConversations.ts" };

test("every model an action soft-deletes can be restored from Trash", () => {
  const deleted = softDeletedByActions();
  assert.ok(deleted.size >= 10, `the scan itself found only: ${[...deleted].join(", ")}`);
  for (const [model, file] of Object.entries(OWN_RESTORE)) {
    assert.match(read(file), new RegExp(`prisma\\.${model}\\.updateMany\\(\\{[^;]*deletedAt: \\{ not: null \\}[^;]*data: \\{ deletedAt: null`), `${model} has its own restore`);
  }
  const missing = [...deleted].filter((m) => !restorable.has(m) && !(m in OWN_RESTORE));
  assert.deepEqual(missing, [], `soft-deleted but not restorable: ${missing.join(", ")}`);
});

test("the page lists every restorable model and the action accepts it", () => {
  const page = read("src/app/(app)/trash/page.tsx");
  for (const model of restorable) {
    assert.match(page, new RegExp(`basePrisma\\.${model}\\.findMany\\(`), `Trash page never lists ${model}`);
  }
  const action = read("src/app/actions/trash.ts");
  assert.match(action, /if \(!RESTORABLE_MODELS\.includes\(model\)\) refuse\(/);
  for (const model of restorable) assert.match(action, new RegExp(`\\b${model}: "/`), `no list path to refresh for ${model}`);
});

test("restore-only models clear just deletedAt, and only on a row that is actually deleted", () => {
  assert.match(lib, /where: \{ id, deletedAt: \{ not: null \}, \.\.\.where \}/);
  assert.match(lib, /\? \{ deletedAt: null, deleteReason: null, deletedByName: null \}\s*: \{ deletedAt: null \}/);
});

test("a cancelled purchase order's incoming units stay gone", () => {
  assert.match(read("src/app/(app)/trash/page.tsx"), /NOT: \{ purchaseOrder: \{ is: \{ status: "cancelled" \} \} \}/);
});

test("refusals reach the owner: SaveForm on the page, a unique clash becomes a message", () => {
  const page = read("src/app/(app)/trash/page.tsx");
  assert.doesNotMatch(page, /<form action=\{restoreFromTrash/);
  assert.match(page, /<SaveForm action=\{restoreFromTrash\.bind\(null, r\.model, r\.id\)\}>/);
  assert.match(read("src/app/actions/trash.ts"), /error\.code === "P2002"\) \{\s*refuse\(/);
});

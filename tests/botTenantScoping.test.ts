import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * A chatbot conversation is identified by `(channel, key)` — a phone number, a
 * Telegram chat id, a Page-scoped id. None of those are unique across tenants:
 * the same customer messaging two tenant-owned WhatsApp numbers produces the SAME
 * key twice. Migration 20260809152000 says so in as many words, and fixed it for
 * BotSession.
 *
 * Every other query keyed that way needs the tenant named too. The guarded client
 * would add it under enforcement, but enforcement is dormant, and these paths
 * DELIVER MESSAGES and MARK ROWS DEAD — `sendProvider` resolves credentials from
 * the ambient scope rather than from the row, so an unscoped claim can send one
 * tenant's message from another tenant's WhatsApp number.
 *
 * This is an invariant rather than a fixed list, so a query added later is caught
 * too.
 */

/** Extract balanced `{...}` starting at `from` (which must index the `{`). */
function braced(code: string, from: number): string {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") {
      depth--;
      if (depth === 0) return code.slice(from, i + 1);
    }
  }
  return code.slice(from);
}

type Call = { model: string; op: string; line: number; where: string | null };

function prismaCalls(code: string, models: Set<string>): Call[] {
  const out: Call[] = [];
  for (const m of code.matchAll(/\bprisma\.(\w+)\.(findFirst|findMany|findUnique|updateMany|update|deleteMany|count)\(\s*\{/g)) {
    if (!models.has(m[1])) continue;
    const args = braced(code, m.index + m[0].length - 1);
    const whereAt = args.indexOf("where:");
    const where = whereAt < 0 ? null : braced(args, args.indexOf("{", whereAt));
    out.push({ model: m[1], op: m[2], line: code.slice(0, m.index).split("\n").length, where });
  }
  return out;
}

test("every chatbot conversation query names the tenant that owns it", () => {
  // Models whose natural key repeats across tenants.
  const models = new Set(["botFlowOutbox", "botFlowPublication", "botSession"]);
  const offenders: string[] = [];

  for (const rel of ["src/lib/botOutbox.ts", "src/lib/flowPublishing.ts", "src/lib/botSessionStore.ts"]) {
    const code = src(rel);
    for (const call of prismaCalls(code, models)) {
      if (call.op === "findUnique") continue;
      if (call.where && /\btenantId\b/.test(call.where)) continue;
      // A row id is a globally unique cuid, so selecting one row by `id:` cannot
      // reach another tenant — those rows were fetched by a tenant-scoped query
      // in the first place. `id: { not: … }` is the opposite: it selects everything
      // EXCEPT one row, so it still has to name the tenant. blockLaterMessages is
      // exactly that shape, and it marks rows dead.
      if (call.where && /\bid:\s*(?!\{)/.test(call.where)) continue;
      offenders.push(`${rel}:${call.line} ${call.model}.${call.op}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "These queries match other tenants' conversations while enforcement is dormant:\n  " + offenders.join("\n  "),
  );
});

test("the parser actually finds the queries it is supposed to guard", () => {
  // Guards against a broken matcher silently passing the invariant above.
  const found = prismaCalls(src("src/lib/botOutbox.ts"), new Set(["botFlowOutbox"]));
  assert.ok(found.length >= 5, `expected the outbox queries to be parsed, found ${found.length}`);
  assert.ok(found.every((call) => call.where !== null), "every parsed call should expose a where clause");
});

test("BotSession's declared identity matches the index the database actually has", () => {
  // The model kept declaring @@unique([channel, key]) after migration
  // 20260809152000 replaced that index with a tenant-scoped one. Prisma treats
  // the schema as the source of truth, so the next `migrate dev` would have
  // written a migration DROPPING the tenant-scoped index and restoring the global
  // one — silently undoing the fix.
  const model = src("prisma/schema.prisma").match(/^model BotSession \{([\s\S]*?)^\}/m);
  assert.ok(model, "BotSession model must exist");
  const declared = model[1].match(/@@unique\(\[([^\]]+)\]\)/);
  assert.ok(declared, "BotSession must declare its identity");
  const columns = declared[1].split(",").map((c) => c.trim());
  assert.deepEqual(columns, ["tenantId", "channel", "key"]);

  const migration = src("prisma/migrations/20260809152000_bot_session_tenant_identity/migration.sql");
  const created = migration.match(/CREATE UNIQUE INDEX[^(]*\(([^)]+)\)/);
  assert.ok(created, "the migration must create the unique index");
  const indexed = created[1].split(",").map((c) => c.trim().replace(/"/g, ""));
  assert.deepEqual(indexed, columns, "schema and migration must agree on BotSession's identity");
});

test("a dead message stops the backlog at the failure, not the conversation for ever", () => {
  const code = src("src/lib/botOutbox.ts");

  // Ordering is enforced at the moment of failure: the whole existing backlog for
  // that conversation is killed in the same step, so nothing queued behind the
  // failure can overtake it — a Meta image and its split-out caption die together.
  const fail = code.slice(code.indexOf("async function failDelivery"), code.indexOf("async function deliverClaimed"));
  assert.match(fail, /blockLaterMessages\(row, lastError\)/);
  const block = code.slice(code.indexOf("async function blockLaterMessages"), code.indexOf("async function failDelivery"));
  assert.match(block, /status: \{ in: \["pending", "retry"\] \}/);
  assert.match(block, /data: \{\s*status: "dead"/);

  // And having done that, a dead row must stop being a barrier — otherwise one
  // undeliverable message silences the bot for that customer for ever.
  const earliest = code.slice(code.indexOf("async function earliestUnfinished"), code.indexOf("async function claimOldest"));
  assert.match(earliest, /status: \{ notIn: \["sent", "dead"\] \}/);
  const claim = code.slice(code.indexOf("async function claimOldest"), code.indexOf("function retryAt"));
  assert.doesNotMatch(claim, /row\.status === "dead"/, "a dead row must no longer veto the claim");
});

test("no chatbot table exists without a Prisma model to certify its tenancy", () => {
  // tenantSchemaContract certifies that every MODEL is global or tenant-scoped
  // before enforcement can be switched on. A table created by raw migration SQL
  // with no model is invisible to it — which is exactly how the earlier RLS
  // coverage drift happened.
  const schema = readdirSync(path.join(root, "prisma"))
    .filter((f) => f.endsWith(".prisma"))
    .map((f) => src(`prisma/${f}`))
    .join("\n");
  const declared = new Set([...schema.matchAll(/^model (\w+) \{/gm)].map((m) => m[1]));

  const created = new Set<string>();
  for (const dir of readdirSync(path.join(root, "prisma/migrations"))) {
    const file = path.join(root, "prisma/migrations", dir, "migration.sql");
    let sql: string;
    try { sql = readFileSync(file, "utf8"); } catch { continue; }
    for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"(Bot\w+)"/g)) created.add(m[1]);
  }

  const orphans = [...created].filter((table) => !declared.has(table));
  assert.deepEqual(orphans, [], `chatbot tables with no Prisma model: ${orphans.join(", ")}`);
});

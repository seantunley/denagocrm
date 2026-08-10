import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(root, "prisma/migrations");

/**
 * Every migration must survive being applied twice.
 *
 * scripts/apply-migrations.mjs opens NO transaction — it splits the file and
 * issues statements one at a time in autocommit — and it records the migration
 * only AFTER executing it. So a statement_timeout, a lock_timeout or a dropped
 * connection leaves a file half-applied and UNRECORDED, and the next deploy
 * re-runs it from statement one. A bare CREATE TABLE / CREATE INDEX / ADD COLUMN
 * / ADD CONSTRAINT then dies on 42P07 / 42701 / 42710 and the deploy is stuck,
 * needing exactly the hand-DDL repair this project has already had to do once.
 *
 * Enforced from the chatbot stack forward. Everything older is allow-listed by
 * date rather than by weakening the rule — those files are already applied.
 */
const ENFORCED_FROM = "20260809000000";

/**
 * Only timestamp-named migrations are in scope. The early ones are numbered
 * `23_saved_views`, `24_error_log` and so on — a plain digit compare puts "23"
 * AFTER "20260809000000" and would drag every one of them in. They are long since
 * applied; the rule is for what comes next.
 */
function enforced(dir: string): boolean {
  const stamp = dir.match(/^(\d{14})_/)?.[1];
  return Boolean(stamp && stamp >= ENFORCED_FROM);
}

/** Strip comments and dollar-quoted bodies: prose and plpgsql are not statements. */
function statementsOnly(sql: string): string {
  return sql
    .replace(/\$\$[\s\S]*?\$\$/g, "")
    .replace(/^\s*--.*$/gm, "");
}

const UNGUARDED: Array<[RegExp, string]> = [
  [/CREATE TABLE (?!IF NOT EXISTS)"/g, "CREATE TABLE without IF NOT EXISTS"],
  [/CREATE (?:UNIQUE )?INDEX (?!IF NOT EXISTS)"/g, "CREATE INDEX without IF NOT EXISTS"],
  [/ADD COLUMN (?!IF NOT EXISTS)"/g, "ADD COLUMN without IF NOT EXISTS"],
  [/ADD CONSTRAINT "/g, "ADD CONSTRAINT outside a pg_constraint guard"],
];

test("every migration from the chatbot stack forward is reentrant", () => {
  const offenders: string[] = [];

  for (const dir of readdirSync(migrationsDir).sort()) {
    if (!enforced(dir)) continue;
    let sql: string;
    try {
      sql = readFileSync(path.join(migrationsDir, dir, "migration.sql"), "utf8");
    } catch {
      continue;
    }
    const body = statementsOnly(sql);
    for (const [pattern, why] of UNGUARDED) {
      for (const hit of body.match(pattern) ?? []) offenders.push(`${dir}: ${why} (${hit.trim()})`);
    }
    // A policy cannot be created IF NOT EXISTS, so it must be dropped first.
    const policies = body.match(/CREATE POLICY "([^"]+)"/g) ?? [];
    for (const policy of policies) {
      const name = policy.match(/"([^"]+)"/)?.[1];
      if (name && !body.includes(`DROP POLICY IF EXISTS "${name}"`)) {
        offenders.push(`${dir}: CREATE POLICY "${name}" with no DROP POLICY IF EXISTS before it`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "The migration runner has no transaction, so these cannot be re-driven after a partial apply:\n  " +
      offenders.join("\n  "),
  );
});

test("a backfill that writes a FORCE-RLS table lifts RLS for itself", () => {
  // Without it the UPDATE matches zero rows where the migrating role does not
  // bypass RLS, SUCCEEDS, and is recorded as applied — the "recorded but never
  // really ran" shape behind the earlier outage.
  const forceRls = new Set<string>();
  const backfills: string[] = [];

  for (const dir of readdirSync(migrationsDir).sort()) {
    let sql: string;
    try {
      sql = readFileSync(path.join(migrationsDir, dir, "migration.sql"), "utf8");
    } catch {
      continue;
    }
    for (const m of sql.matchAll(/ALTER TABLE "(\w+)" FORCE ROW LEVEL SECURITY/g)) forceRls.add(m[1]);
    if (!enforced(dir)) continue;

    const body = statementsOnly(sql);
    for (const m of body.matchAll(/UPDATE "(\w+)"/g)) {
      if (!forceRls.has(m[1])) continue;
      if (/SET app\.bypass_rls = 'on'/.test(body)) continue;
      backfills.push(`${dir}: UPDATE "${m[1]}" with no SET app.bypass_rls`);
    }
  }

  assert.deepEqual(backfills, [], backfills.join("\n  "));
});

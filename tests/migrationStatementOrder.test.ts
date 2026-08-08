import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * A MIGRATION MAY NOT TOUCH A TABLE BEFORE IT CREATES IT.
 *
 * 20260808120000_inbox_collaboration shipped with
 *
 *   ALTER TABLE "ConversationDraft" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
 *
 * eleven statements BEFORE its own CREATE TABLE. On an empty database that is
 * `relation "ConversationDraft" does not exist`, the migration step dies, and
 * every later CI step — typecheck, tests, security, RLS, two-tenant isolation —
 * is skipped rather than run.
 *
 * It was introduced while fixing the opposite blind spot: production had the table
 * already, so `CREATE TABLE IF NOT EXISTS` was a no-op there and a later statement
 * needed the column added explicitly. The compatibility ALTER was correct; putting
 * both of them next to the FIRST table's create was not.
 *
 * This reads every migration and fails when a file alters, indexes or
 * constraint-adds a table it creates LATER in the same file. It cannot know about
 * tables created by earlier migrations — that is fine, those exist by then. The
 * only thing it needs to catch is a file contradicting itself, which is the
 * mistake that is easy to make and invisible in review.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const migrationsDir = join(root, "prisma", "migrations");

/** Strip comments and string literals so a table name in prose is not a match. */
function code(sql: string): string {
  return sql
    .replace(/\$\$[\s\S]*?\$\$/g, " ") // dollar-quoted bodies: their own scope
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'[^']*'/g, " ");
}

type Reference = { table: string; index: number; statement: string };

/** Where each table is CREATEd, and where it is otherwise referenced, in order. */
function scan(sql: string): { creates: Map<string, number>; uses: Reference[] } {
  const creates = new Map<string, number>();
  const uses: Reference[] = [];

  const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"([A-Za-z_][A-Za-z0-9_]*)"/gi;
  for (let m = createRe.exec(sql); m; m = createRe.exec(sql)) {
    // First create wins: a later duplicate cannot make an earlier reference legal.
    if (!creates.has(m[1])) creates.set(m[1], m.index);
  }

  // The three ways a migration touches a table it may not have made yet.
  const patterns: Array<[RegExp, string]> = [
    [/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?"([A-Za-z_][A-Za-z0-9_]*)"/gi, "ALTER TABLE"],
    [/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"[^"]+"\s+ON\s+"([A-Za-z_][A-Za-z0-9_]*)"/gi, "CREATE INDEX"],
    [/CREATE\s+POLICY\s+"[^"]+"\s+ON\s+"([A-Za-z_][A-Za-z0-9_]*)"/gi, "CREATE POLICY"],
  ];
  for (const [re, label] of patterns) {
    for (let m = re.exec(sql); m; m = re.exec(sql)) {
      uses.push({ table: m[1], index: m.index, statement: label });
    }
  }
  return { creates, uses };
}

test("the scanner sees an out-of-order reference", () => {
  // Guard the tool before trusting it. Verbatim shape of the defect.
  const broken = `
    CREATE TABLE IF NOT EXISTS "A" ("id" TEXT);
    ALTER TABLE "B" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
    CREATE TABLE IF NOT EXISTS "B" ("id" TEXT);
  `;
  const { creates, uses } = scan(code(broken));
  const bad = uses.filter((use) => {
    const created = creates.get(use.table);
    return created !== undefined && use.index < created;
  });
  assert.equal(bad.length, 1, "the out-of-order ALTER must be found");
  assert.equal(bad[0].table, "B");

  // …and does NOT flag the correct order.
  const fixed = `
    CREATE TABLE IF NOT EXISTS "B" ("id" TEXT);
    ALTER TABLE "B" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
  `;
  const ok = scan(code(fixed));
  assert.equal(
    ok.uses.filter((u) => (ok.creates.get(u.table) ?? -1) > u.index).length,
    0,
  );
});

test("no migration touches a table before creating it", () => {
  const names = readdirSync(migrationsDir).filter((entry) =>
    existsSync(join(migrationsDir, entry, "migration.sql")),
  );
  assert.ok(names.length > 100, `expected the migration set, found ${names.length}`);

  const problems: string[] = [];
  for (const name of names) {
    const sql = code(readFileSync(join(migrationsDir, name, "migration.sql"), "utf8"));
    const { creates, uses } = scan(sql);
    for (const use of uses) {
      const created = creates.get(use.table);
      if (created !== undefined && use.index < created) {
        problems.push(`${name}: ${use.statement} "${use.table}" appears before its CREATE TABLE`);
      }
    }
  }
  assert.deepEqual(problems, [], `\n  ${problems.join("\n  ")}\n`);
});

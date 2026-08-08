import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { splitSqlStatements } from "../scripts/lib/splitSqlStatements.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "prisma", "migrations");

// ---------------------------------------------------------------------------
// Lexical rules
//
// Each of these is a way a naive `sql.split(";")` gets a migration wrong. The
// consequence is never a clean error: it is half a PL/pgSQL body sent to the
// server, or a statement swallowed into a string and silently never run.
// ---------------------------------------------------------------------------

test("splits plain statements and drops the empty tail", () => {
  assert.deepEqual(splitSqlStatements("SELECT 1; SELECT 2;"), ["SELECT 1", "SELECT 2"]);
});

test("keeps a trailing statement that has no final semicolon", () => {
  assert.deepEqual(splitSqlStatements("SELECT 1;\nSELECT 2"), ["SELECT 1", "SELECT 2"]);
});

test("a semicolon inside a single-quoted string does not split", () => {
  assert.deepEqual(splitSqlStatements("SELECT 'a;b';"), ["SELECT 'a;b'"]);
});

test("a doubled quote does not end the string early", () => {
  assert.deepEqual(splitSqlStatements("SELECT 'it''s; fine';"), ["SELECT 'it''s; fine'"]);
});

test("quote doubling cannot change a split, by construction", () => {
  // Honest note: disabling the doubling branch in the scanner breaks none of
  // these tests, and that is not a gap in the tests — no input can distinguish
  // it. Reading '' as one escaped quote, or as a close immediately followed by
  // a reopen, covers exactly the same characters, because the two quotes are
  // adjacent and so no code ever sits between them. Parity is preserved either
  // way, so the scanner ends every run inside or outside a string identically.
  //
  // The branch is kept because it makes the scanner match PostgreSQL's actual
  // lexical rule, which matters the moment anything wants the string's VALUE
  // rather than just its extent. These cases pin the equivalence so a future
  // change that does depend on it has a place to fail.
  for (const sql of [
    "SELECT 'a''b;c'; SELECT 2;",
    "SELECT 'a'';'; SELECT 2;",
    "SELECT ''';'''; SELECT 2;",
    `SELECT "id""x;y" FROM t; SELECT 2;`,
  ]) {
    const parts = splitSqlStatements(sql);
    assert.equal(parts.length, 2, `expected two statements from: ${sql}`);
    assert.equal(parts[1], "SELECT 2");
  }
});

test("a semicolon inside a quoted identifier does not split", () => {
  assert.deepEqual(splitSqlStatements('ALTER TABLE "we;ird" ADD COLUMN a int;'), [
    'ALTER TABLE "we;ird" ADD COLUMN a int',
  ]);
});

test("an E-string's backslash-escaped quote does not end the string", () => {
  // Without escape-string handling the string ends at the \' and the rest of
  // the line is read as SQL — the ';' would then split mid-statement.
  assert.deepEqual(splitSqlStatements("SELECT E'a\\';b';"), ["SELECT E'a\\';b'"]);
});

test("E is only an escape string when it does not end an identifier", () => {
  // `LIKE'x'` is valid Postgres with no space. The E of LIKE must not turn the
  // string into an escape string, which would give backslash a meaning it does
  // not have here.
  assert.deepEqual(splitSqlStatements("SELECT 1 WHERE a LIKE'x\\';"), ["SELECT 1 WHERE a LIKE'x\\'"]);
});

test("semicolons inside an anonymous dollar-quoted body do not split", () => {
  const sql = "DO $$ BEGIN PERFORM 1; PERFORM 2; END $$;";
  assert.deepEqual(splitSqlStatements(sql), ["DO $$ BEGIN PERFORM 1; PERFORM 2; END $$"]);
});

test("semicolons inside a NAMED dollar-quoted body do not split", () => {
  // The corpus uses $sql$, $backfill$, $tenant_backfill$ and
  // $retire_automation_rules$. Matching only "$$" cuts these in half.
  const sql = "DO $backfill$ BEGIN UPDATE t SET a = 1; END $backfill$;";
  assert.deepEqual(splitSqlStatements(sql), ["DO $backfill$ BEGIN UPDATE t SET a = 1; END $backfill$"]);
});

test("a different tag inside a dollar body is literal text", () => {
  const sql = "DO $outer$ SELECT '$$'; SELECT 1; $outer$;";
  assert.deepEqual(splitSqlStatements(sql), ["DO $outer$ SELECT '$$'; SELECT 1; $outer$"]);
});

test("positional parameters are not dollar-quote openers", () => {
  // $1 cannot open a dollar quote (a tag may not start with a digit). If it
  // did, everything to the next '$' would be swallowed.
  assert.deepEqual(splitSqlStatements("SELECT $1; SELECT $2;"), ["SELECT $1", "SELECT $2"]);
});

test("a lone dollar in a string is not a dollar-quote opener", () => {
  // From 20260804120000_reporting_statistics: E'... psql "$DATABASE_URL_UNPOOLED" ...'
  const sql = `SELECT E'psql "$DATABASE_URL_UNPOOLED" -f x.sql'; SELECT 1;`;
  assert.deepEqual(splitSqlStatements(sql), [
    `SELECT E'psql "$DATABASE_URL_UNPOOLED" -f x.sql'`,
    "SELECT 1",
  ]);
});

test("a semicolon in a line comment does not split", () => {
  assert.deepEqual(splitSqlStatements("SELECT 1 -- a; comment\n;"), ["SELECT 1 -- a; comment"]);
});

test("a semicolon in a block comment does not split", () => {
  assert.deepEqual(splitSqlStatements("SELECT /* a; b */ 1;"), ["SELECT /* a; b */ 1"]);
});

test("block comments nest, as they do in PostgreSQL", () => {
  // Most dialects end the comment at the first */. PostgreSQL does not, so a
  // non-nesting scanner would resume parsing inside a comment.
  assert.deepEqual(splitSqlStatements("SELECT /* a /* b; */ c; */ 1;"), ["SELECT /* a /* b; */ c; */ 1"]);
});

test("comment-only fragments are dropped, not sent as empty queries", () => {
  assert.deepEqual(splitSqlStatements("SELECT 1;\n-- trailing note\n"), ["SELECT 1"]);
  assert.deepEqual(splitSqlStatements("-- only a comment\n"), []);
  assert.deepEqual(splitSqlStatements("  \n\t\n"), []);
  assert.deepEqual(splitSqlStatements(";;;"), []);
});

test("comments attached to a statement are preserved inside it", () => {
  const sql = "-- why this guard exists\nALTER TABLE t ADD COLUMN a int;";
  assert.deepEqual(splitSqlStatements(sql), ["-- why this guard exists\nALTER TABLE t ADD COLUMN a int"]);
});

test("an unterminated dollar body is left intact for the server to reject", () => {
  // Guessing a terminator here would invent SQL nobody wrote.
  assert.deepEqual(splitSqlStatements("DO $$ BEGIN PERFORM 1;"), ["DO $$ BEGIN PERFORM 1;"]);
});

// ---------------------------------------------------------------------------
// The real corpus
//
// The unit tests above encode what I believe the rules are. These run the
// splitter over every migration this repository will actually apply and check
// properties that hold regardless of whether I got the rules right.
// ---------------------------------------------------------------------------

function migrationFiles(): { name: string; sql: string }[] {
  return readdirSync(migrationsDir)
    .filter((name) => existsSync(join(migrationsDir, name, "migration.sql")))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(migrationsDir, name, "migration.sql"), "utf8") }));
}

/** Text between two statements may only be whitespace, ';' and comments. */
function gapIsInert(gap: string): boolean {
  let s = gap;
  for (;;) {
    const stripped = s.replace(/^\s+/, "").replace(/^;/, "");
    if (stripped !== s) {
      s = stripped;
      continue;
    }
    const line = s.match(/^--[^\n]*\n?/);
    if (line) {
      s = s.slice(line[0].length);
      continue;
    }
    if (s.startsWith("/*")) {
      let depth = 1;
      let i = 2;
      while (i < s.length && depth > 0) {
        if (s.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (s.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
      s = s.slice(i);
      continue;
    }
    break;
  }
  return s.trim() === "";
}

test("every migration splits without losing or inventing SQL", () => {
  const files = migrationFiles();
  assert.ok(files.length >= 180, `expected the full corpus, saw ${files.length}`);

  let total = 0;
  for (const { name, sql } of files) {
    const parts = splitSqlStatements(sql);
    total += parts.length;

    // Each statement must appear VERBATIM, in order, and everything skipped
    // between them must be inert. Together these mean nothing was dropped,
    // reordered, duplicated or rewritten.
    let cursor = 0;
    for (const part of parts) {
      const at = sql.indexOf(part, cursor);
      assert.notEqual(at, -1, `${name}: statement not found verbatim: ${part.slice(0, 60)}`);
      assert.ok(
        gapIsInert(sql.slice(cursor, at)),
        `${name}: real SQL dropped between statements: ${JSON.stringify(sql.slice(cursor, at)).slice(0, 90)}`,
      );
      cursor = at + part.length;
    }
    assert.ok(gapIsInert(sql.slice(cursor)), `${name}: real SQL dropped after the last statement`);
  }
  assert.ok(total > 2000, `expected a few thousand statements, got ${total}`);
});

test("no migration statement cuts a dollar-quoted body in half", () => {
  // The failure this guards against is the dangerous one: half a PL/pgSQL body
  // is still valid-looking text, and the server error it produces points at the
  // fragment rather than at the splitter.
  let bodies = 0;
  for (const { name, sql } of migrationFiles()) {
    for (const statement of splitSqlStatements(sql)) {
      const counts = new Map<string, number>();
      for (const m of statement.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)?\$/g)) {
        counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
      }
      if (counts.size) bodies++;
      for (const [tag, count] of counts) {
        assert.equal(count % 2, 0, `${name}: unbalanced ${tag} (x${count}) in: ${statement.slice(0, 70)}`);
      }
      assert.ok(
        !/^\s*(END|\$\$)\b/i.test(statement),
        `${name}: statement begins mid-block: ${statement.slice(0, 70)}`,
      );
    }
  }
  assert.ok(bodies > 100, `expected many dollar-quoted bodies in the corpus, saw ${bodies}`);
});

test("the file with E-strings and a stray dollar survives intact", () => {
  // 20260804120000_reporting_statistics builds an error message from E'' parts
  // containing \n escapes, doubled '' quotes and `"$DATABASE_URL_UNPOOLED"`.
  // It is the single most hostile file in the corpus for a naive splitter.
  const name = "20260804120000_reporting_statistics";
  const sql = readFileSync(join(migrationsDir, name, "migration.sql"), "utf8");
  const parts = splitSqlStatements(sql);
  const message = parts.find((p) => p.includes("refusing to build indexes inline"));
  assert.ok(message, "the guard statement should survive as one statement");
  assert.ok(
    message!.includes("SET app.allow_blocking_index_build"),
    "the whole message body should stay in one statement, not be split at its semicolons",
  );
});

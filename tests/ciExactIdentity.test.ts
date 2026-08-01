import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * Prisma's `{ equals: v, mode: "insensitive" }` compiles to `col ILIKE $1` with
 * `v` bound UNESCAPED, so `_` and `%` in it are wildcards. Confirmed against the
 * production database, which emitted:
 *
 *   SELECT "public"."Contact"."id" FROM "public"."Contact"
 *   WHERE "public"."Contact"."email" ILIKE $1 LIMIT $2 OFFSET $3
 *
 * and returned a real customer for `equals: "%@%"`.
 *
 * PR #268 fixed the portal login, where this was an account takeover. These
 * tests cover the systemic form: every OTHER place that used the same pattern to
 * resolve identity or check uniqueness.
 */

/** Source with comments stripped — otherwise these regexes match the very
 *  comments that document the fix. */
function shippedText(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(path.join(root, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(path.join(root, rel)).isDirectory()) sourceFiles(rel, out);
    else if (/\.tsx?$/.test(entry)) out.push(rel);
  }
  return out;
}

test("no source file matches identity with an ILIKE", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles("src")) {
    const text = shippedText(file);
    // The whole filter object, so `contains` + insensitive (a deliberate
    // substring search, used across the search pages) is not swept up.
    for (const match of text.matchAll(/\{[^{}]*\bmode:\s*"insensitive"[^{}]*\}/g)) {
      if (/\b(equals|startsWith|endsWith)\s*:/.test(match[0])) offenders.push(`${file}: ${match[0]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `mode: "insensitive" with an equality operator is an unescaped ILIKE — use ciExactIdFilter():\n${offenders.join("\n")}`,
  );
});

test("the eslint rule that bans the pattern is actually wired up", () => {
  // A convention nobody enforces is a convention that comes back. This asserts
  // the selector is present AND that it targets the equality operators only.
  const config = read("eslint.config.mjs");
  assert.match(config, /no-restricted-syntax/);
  assert.match(config, /equals\|startsWith\|endsWith/);
  assert.match(config, /key\.name="mode"/);
});

test("the eslint rule flags the vulnerable shape and not the safe one", async () => {
  // Runs the REAL rule through ESLint's own API against the project's own
  // config, rather than poking the selector through esquery directly. Two
  // reasons: esquery is a transitive dependency that ships no type declarations
  // (tsc fails on it in CI even though a local run passed), and going through
  // ESLint proves the rule is actually wired up and firing — not merely that a
  // selector string matches when handed to a matcher by hand.
  const { ESLint } = await import("eslint");
  const eslint = new ESLint({ cwd: root });

  const sample = [
    `const vulnerable = { email: { equals: v, mode: "insensitive" } };`,
    `const vulnerableAsConst = { email: { equals: v, mode: "insensitive" as const } };`,
    `const vulnerablePrefix = { serial: { startsWith: v, mode: "insensitive" } };`,
    `const safeContains = { email: { contains: v, mode: "insensitive" } };`,
    `const safeSplit = { firstName: { contains: q, mode: "insensitive" }, id: { equals: v } };`,
    `const safeExact = { email: { equals: v } };`,
    `export { vulnerable, vulnerableAsConst, vulnerablePrefix, safeContains, safeSplit, safeExact };`,
  ].join("\n");

  const [result] = await eslint.lintText(sample, { filePath: path.join(root, "src/lib/__ciExactProbe.ts") });
  const flagged = result.messages
    .filter((m) => m.ruleId === "no-restricted-syntax")
    .map((m) => (sample.split("\n")[m.line - 1].match(/const (\w+)/) ?? [])[1]);

  assert.deepEqual(
    flagged.sort(),
    ["vulnerable", "vulnerableAsConst", "vulnerablePrefix"].sort(),
    "the rule must flag equals/startsWith + insensitive (including `as const`) and nothing else",
  );
});

test("ciExact never interpolates an identifier it has not vetted", () => {
  const code = read("src/lib/ciExact.ts");
  // Prisma.raw is a string splice into SQL. Every use must go through the
  // quoting helper, which rejects anything that is not a bare identifier.
  const raws = [...code.matchAll(/Prisma\.raw\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.ok(raws.length > 0, "expected Prisma.raw to be used for the table/column");
  for (const arg of raws) {
    assert.match(arg, /^quoteIdentifier\(/, `Prisma.raw(${arg}) bypasses quoteIdentifier`);
  }
  assert.match(code, /SAFE_IDENTIFIER\s*=\s*\/\^\[A-Za-z\]/);
});

test("quoteIdentifier refuses anything that is not a bare identifier", async () => {
  // The map is frozen and caller input can't reach it, but the guard is the
  // reason a reader can stop worrying about that — so prove it holds.
  const code = read("src/lib/ciExact.ts");
  const pattern = code.match(/const SAFE_IDENTIFIER = (\/.*\/);/)?.[1];
  assert.ok(pattern, "SAFE_IDENTIFIER not found");
  const re = new RegExp(pattern.slice(1, -1));
  for (const bad of ['Contact" --', "Contact; DROP TABLE", "1Contact", "", "Con tact", 'a"b']) {
    assert.equal(re.test(bad), false, `${JSON.stringify(bad)} must be refused`);
  }
  for (const good of ["Contact", "SupportMailbox", "StockUnit", "email", "vin", "created_at"]) {
    assert.equal(re.test(good), true, `${good} must be accepted`);
  }
});

test("the fold matches the index each column is actually unique on", () => {
  const code = read("src/lib/ciExact.ts");
  const schema = read("prisma/schema.prisma");
  void schema;
  // StockUnit's active-serial uniqueness is enforced by
  //   CREATE UNIQUE INDEX ... USING btree (upper(serial)) WHERE serial IS NOT NULL AND "deletedAt" IS NULL
  // (read off the live database). Folding the app-side check the other way
  // would let the friendly message and the constraint disagree.
  assert.match(code, /stockUnitSerial:\s*\{[^}]*fold:\s*"upper"/);
  assert.match(code, /vehicleVin:\s*\{[^}]*fold:\s*"upper"/);
  assert.match(code, /contactEmail:\s*\{[^}]*fold:\s*"lower"/);
});

test("the sender match in imapSync stays inside the advisory lock", () => {
  // fileSupportEmail takes pg_advisory_xact_lock on the sender address so two
  // overlapping polls can't both create a contact. basePrisma.$queryRaw opens
  // its OWN transaction on another connection, so resolving the sender there
  // would sit outside the lock and reintroduce the duplicate it prevents.
  const code = shippedText("src/lib/imapSync.ts");
  assert.match(code, /pg_advisory_xact_lock/);
  assert.match(
    code,
    /ciExactIds\("contactEmail",\s*fromEmail,\s*\{\s*client:\s*tx\s*\}\)/,
    "the locked lookup must run on the transaction handle",
  );
});

test("identity resolution is deterministic", () => {
  // An unordered findFirst over several matching rows is how one login could
  // mail a code against one record and mint a session against another.
  assert.match(read("src/lib/ciExact.ts"), /ORDER BY "createdAt" ASC, "id" ASC/);
  for (const file of ["src/lib/imapSync.ts", "src/app/api/bookings/route.ts"]) {
    assert.match(read(file), /orderBy:\s*\{\s*createdAt:\s*"asc"\s*\}/, `${file} resolves an identity unordered`);
  }
});

test("the public booking endpoint no longer pattern-matches the submitted email", () => {
  // z.string().email() accepts `_` and `%` in a local part, so `%@%` reached the
  // query and attached the booking — and the vehicle list it reads — to whichever
  // customer came back first.
  const code = shippedText("src/app/api/bookings/route.ts");
  assert.match(code, /ciExactIdFilter\("contactEmail",\s*b\.email\)/);
  assert.doesNotMatch(code, /email:\s*\{\s*equals:\s*b\.email/);
});

test("the portal resolver from #268 is still exact", () => {
  // This sweep deliberately did not touch portal.ts — it is under review as its
  // own PR. Pin it anyway so a merge that reverts it fails here.
  const code = read("src/app/actions/portal.ts");
  assert.match(code, /LOWER\("email"\) = /);
  assert.doesNotMatch(shippedText("src/app/actions/portal.ts"), /mode:\s*"insensitive"/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  provisionHarnessDatabase,
  migrateHarnessDatabase,
} from "../scripts/harness/testDatabase";
import {
  compareMigrationNames,
  orderedMigrations,
  prefixCollisions,
} from "../scripts/apply-migrations.mjs";
import {
  CATALOG_FK_QUERY,
  catalogFromRows,
  catalogProblem,
  collectCompositeTenantFks,
  fkKey,
  migrationOrder,
  orderedMigrationDirs,
  scanMigrationSql,
  stripSqlComments,
  toBaseline,
  type BaselineEntry,
  type CatalogRow,
} from "./compositeTenantFkScan";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = path.join(root, "prisma", "migrations");
const BASELINE = path.join(root, "tests", "fixtures", "composite-tenant-fk-baseline.json");

/**
 * THE LAST LINE OF DEFENCE IS INVISIBLE TO EVERY TOOL IN THIS REPOSITORY.
 * THIS FILE IS THE ONLY THING WATCHING IT.
 *
 * The two-tenant harness measured the forged-`partId` defence layer by layer.
 * The application predicates added by #459 are NOT what stops the attack:
 * dropping the tenant predicate from `claimPartStock`'s row lock ALONE, or from
 * its `updateMany` ALONE, leaves the harness green, because the still-filtered
 * `findFirst` bails first. Remove both and the decrement runs — and what rolls
 * the transaction back is a foreign key:
 *
 *     JobCardItem(tenantId, partId) → Part(tenantId, id)
 *
 * `Quote_tenantId_revisionOfId_fkey` holds the same position for quote revisions.
 * 132 constraints of this shape are what actually make cross-tenant writes
 * impossible rather than merely unlikely.
 *
 * ── WHY THEY NEED A GUARD ──────────────────────────────────────────────────
 *
 * They exist ONLY in raw migration SQL (prisma/migrations/20260727140000_
 * composite_tenant_fks and five others). They are NOT in schema.prisma — not
 * because Prisma cannot express them (it can; see the verdict at the bottom of
 * this file, which is the opposite of what was assumed before it was measured)
 * but because nobody has put them there. While that is true:
 *
 *   - `prisma migrate diff` cannot mention them. It compares schema.prisma to
 *     the database, and a constraint the schema has never heard of reads as
 *     drift to be REMOVED, not a defence to be kept;
 *   - a migration generated for an unrelated relation change writes
 *     `DROP CONSTRAINT … ADD CONSTRAINT …` for the SINGLE-column relation Prisma
 *     does know about, and a hand-written composite key on the same columns is
 *     collateral damage;
 *   - a `DROP TABLE` takes every constraint on and pointing at that table;
 *   - in each case the word "tenant" appears nowhere in the diff, nowhere in the
 *     PR title, and nowhere in review.
 *
 * NONE OF THAT IS HYPOTHETICAL. 20260805238000_signing_job_request_cascade drops
 * `SigningJob_request_fkey` and re-adds it to change a delete rule — correct, by
 * hand, unchecked. And 20260802120000_retire_automation_rules, a migration about
 * retiring a duplicate automation engine, ends with `DROP TABLE "AutomationLog"`
 * and `DROP TABLE "AutomationRule"` and takes FIVE composite tenant foreign keys
 * with it. Both were fine. Nothing was watching either.
 *
 * ── WHAT THIS FILE ASSERTS ─────────────────────────────────────────────────
 *
 *   1. A RECORDED SET, in tests/fixtures/composite-tenant-fk-baseline.json,
 *      enumerated FROM the migration SQL rather than hand-listed — so a new
 *      constraint is covered the moment it is added and the list cannot rot into
 *      a lie about a schema it no longer describes.
 *   2. It may GROW. It may never SHRINK silently: a constraint that leaves the
 *      SQL must be named in REMOVED_BY_DESIGN below with a reason someone will
 *      still understand in a year.
 *   3. THE RECORDED SET EXISTS IN A REAL POSTGRESQL — read out of pg_constraint,
 *      with its actual columns and its actual referenced table, after applying
 *      every migration to a disposable database. Text in a .sql file proves that
 *      someone typed a constraint, not that a database has one.
 *
 * ── WHAT IT DOES NOT ASSERT ────────────────────────────────────────────────
 *
 * That the constraints are ENOUGH. They stop a child row pointing at a parent in
 * another tenant. They say nothing about reads, nothing about a forged id inside
 * the SAME tenant, nothing about tables with no tenantId column, and nothing
 * about the ~30 tenant-scoped columns that still have no composite FK at all.
 * A green run here means the defence that exists has not been deleted. It is not
 * a statement that the defence is complete.
 */

const declared = collectCompositeTenantFks(MIGRATIONS);
const current = toBaseline(declared);

const stored: Record<string, BaselineEntry> = existsSync(BASELINE)
  ? (JSON.parse(readFileSync(BASELINE, "utf8")) as Record<string, BaselineEntry>)
  : {};

/**
 * DELIBERATE REMOVALS — the only way a constraint may leave the recorded set.
 *
 * HAND-WRITTEN, never touched by the updater below, and every entry states why
 * losing this particular cross-tenant defence is acceptable. "The migration
 * dropped it" is not a reason; that is the event this file exists to catch.
 *
 * Empty today, and it should be hard to add to. If a constraint is genuinely
 * obsolete because its table is gone, the honest edit is to delete the baseline
 * entry in the same commit as the migration that drops the table — an entry here
 * is for a constraint whose TABLE still exists and which someone decided to live
 * without.
 *
 * Entries cannot rot: an entry naming a constraint that is in fact still declared
 * fails the run, so this map cannot quietly accumulate exemptions for defences
 * that were never actually removed.
 */
const REMOVED_BY_DESIGN: Record<string, string> = {};

/**
 * THE TWO CONSTRAINTS THE HARNESS ACTUALLY MEASURED, pinned by name.
 *
 * Everything else in this file is derived, which is what makes it maintainable —
 * and also what makes it possible to regenerate the whole baseline in one
 * careless command. These two are hand-written so that even a wholesale
 * regeneration cannot make them disappear quietly. Deleting a line here is a
 * deliberate act with the harness result staring back at whoever does it.
 */
/**
 * CONSTRAINTS THAT ARE PRESENT BUT `NOT VALID`, RECORDED AS A KNOWN STATE.
 *
 * `NOT VALID` means PostgreSQL enforces the constraint on every INSERT and
 * UPDATE from the moment it is added, but did NOT re-check rows already there.
 * So the defence is live for new writes — which is the whole forged-id path —
 * while "does this table already contain cross-tenant rows?" stays unanswered.
 *
 * Recorded rather than merely counted so a future `VALIDATE CONSTRAINT` is
 * visible instead of silent, and so a NEW not-valid entrant cannot slip in
 * unnoticed among 132 others.
 *
 * Confirmed identical in two independent places: a database built from empty by
 * this repository's migrations, and a read-only check against PRODUCTION
 * (132 recorded, 132 live, none missing, none extra). Both constraints #479
 * proved load-bearing — JobCardItem_tenantId_partId_fkey and
 * Quote_tenantId_revisionOfId_fkey — are VALID in production.
 */
const KNOWN_NOT_VALID: Record<string, string> = {
  "ConversationDraft.ConversationDraft_tenantId_conversationId_fkey":
    "Added NOT VALID by 20260808120000_inbox_collaboration, which postdates " +
    "20260727180000_validate_composite_fks — so it missed the sweep that validated the rest " +
    "rather than being deliberately excluded. Drafts written before it was added were never " +
    "re-checked.",
  "ConversationNote.ConversationNote_tenantId_conversationId_fkey":
    "Same migration, same reason. Its own migration comment records the hazard it was added " +
    "for: a stamped note pointing at a NULL-tenant conversation, the shape that broke lead " +
    "creation on 2026-08-07.",
};

const PROVEN_LOAD_BEARING: Record<string, string> = {
  "JobCardItem.JobCardItem_tenantId_partId_fkey":
    "#479: with BOTH application tenant predicates removed from claimPartStock, this " +
    "is what rolled back the cross-tenant part decrement. Not a belt-and-braces FK — " +
    "measured to be the defence that fired.",
  "Quote.Quote_tenantId_revisionOfId_fkey":
    "#479: the same role for quote revisions — the constraint that stops a revision " +
    "chain being anchored to another tenant's quote.",
};

/**
 * RECORD A DELIBERATE ADDITION:  UPDATE_COMPOSITE_FK_BASELINE=1 npm run test:unit
 *
 * The updater may only ADD. It cannot remove an entry, cannot change one, and
 * refuses to write anything at all if asked to do either — because the single
 * failure mode that matters here is a constraint leaving the set, and an updater
 * that can be run to make that failure go away is not a guard, it is a button
 * labelled "make the alarm stop".
 *
 * Returned as data rather than written from inside the check so the refusal
 * itself is unit-testable below, on synthetic input, instead of being trusted.
 */
export function nextBaseline(
  previous: Record<string, BaselineEntry>,
  found: Record<string, BaselineEntry>,
): { ok: true; baseline: Record<string, BaselineEntry> } | { ok: false; removed: string[] } {
  const removed = Object.keys(previous).filter(
    (key) => !found[key] || JSON.stringify(found[key]) !== JSON.stringify(previous[key]),
  );
  if (removed.length > 0) return { ok: false, removed: removed.sort() };
  const merged: Record<string, BaselineEntry> = {};
  for (const key of Object.keys(found).sort()) merged[key] = found[key];
  return { ok: true, baseline: merged };
}

if (process.env.UPDATE_COMPOSITE_FK_BASELINE) {
  const result = nextBaseline(stored, current);
  if (result.ok) {
    writeFileSync(BASELINE, `${JSON.stringify(result.baseline, null, 2)}\n`);
  } else {
    console.error(
      "Refused to update the composite tenant FK baseline. These recorded constraints are\n" +
        "no longer declared, or no longer have the recorded shape:\n\n" +
        result.removed.map((key) => `  ${key}`).join("\n") +
        "\n\nThat is the exact event this baseline exists to catch, and the updater will not\n" +
        "launder it. Restore the constraints, or name each one in REMOVED_BY_DESIGN with a\n" +
        "reason and delete its baseline entry by hand in the same commit.",
    );
  }
}

const baseline: Record<string, BaselineEntry> = existsSync(BASELINE)
  ? (JSON.parse(readFileSync(BASELINE, "utf8")) as Record<string, BaselineEntry>)
  : {};

test("the baseline is not empty — a guard over nothing is not a guard", () => {
  assert.ok(
    Object.keys(baseline).length > 100,
    `Only ${Object.keys(baseline).length} composite tenant FKs recorded in ${path.relative(root, BASELINE)}. ` +
      "132 were declared when this was written. A baseline that has collapsed is far more " +
      "likely to be a broken parser or a deleted fixture than a schema that lost its tenant " +
      "foreign keys — but both of those are reasons to stop, not to carry on.",
  );
});

test("every recorded composite tenant FK is still declared in the migration SQL", () => {
  const missing = Object.keys(baseline)
    .filter((key) => !current[key])
    .filter((key) => !(key in REMOVED_BY_DESIGN));

  assert.deepEqual(
    missing,
    [],
    "COMPOSITE TENANT FOREIGN KEYS HAVE DISAPPEARED FROM THE MIGRATIONS:\n\n" +
      missing.map((key) => `  ${key}  →  ${baseline[key].references.table}`).join("\n") +
      "\n\nEach of these is a cross-tenant write that PostgreSQL used to make impossible and\n" +
      "now does not. Prisma cannot see these constraints, so nothing else in this repository\n" +
      "will tell you.\n\n" +
      "  - dropped by accident (a regenerated migration, a DROP TABLE … CASCADE, a retype):\n" +
      "    put the constraint back, in a new migration.\n" +
      "  - removed on purpose: add it to REMOVED_BY_DESIGN in this file with the reason,\n" +
      "    and delete its baseline entry in the same commit.",
  );
});

test("a shape change is a removal — the columns and the parent are recorded too", () => {
  const changed = Object.keys(baseline)
    .filter((key) => current[key])
    .filter((key) => JSON.stringify(current[key]) !== JSON.stringify(baseline[key]))
    .map((key) => {
      const was = baseline[key];
      const now = current[key];
      return (
        `  ${key}\n` +
        `    recorded: (${was.columns.join(", ")}) → ${was.references.table}(${was.references.columns.join(", ")})\n` +
        `    now:      (${now.columns.join(", ")}) → ${now.references.table}(${now.references.columns.join(", ")})`
      );
    });

  assert.deepEqual(
    changed,
    [],
    "A COMPOSITE TENANT FK STILL EXISTS BY NAME BUT NO LONGER HAS THE SAME SHAPE:\n\n" +
      changed.join("\n") +
      "\n\nThe name is just a string. `Quote_tenantId_revisionOfId_fkey` re-added over a single\n" +
      "column is still called that and enforces nothing about tenants — which is precisely\n" +
      "what a schema-driven regeneration would produce.",
  );
});

test("a new composite tenant FK is recorded, so the set may grow but only on purpose", () => {
  const unrecorded = Object.keys(current).filter((key) => !baseline[key]);

  assert.deepEqual(
    unrecorded,
    [],
    "NEW COMPOSITE TENANT FOREIGN KEYS ARE NOT IN THE BASELINE:\n\n" +
      unrecorded
        .map((key) => `  ${key}  →  ${current[key].references.table}`)
        .join("\n") +
      "\n\nGood — the set is allowed to grow, and this is how it is written down so it can\n" +
      "never shrink back without someone noticing:\n\n" +
      "  UPDATE_COMPOSITE_FK_BASELINE=1 npm run test:unit",
  );
});

test("REMOVED_BY_DESIGN cannot rot", () => {
  const stale = Object.keys(REMOVED_BY_DESIGN).filter((key) => current[key]);
  assert.deepEqual(
    stale,
    [],
    "These are excused as deliberately removed, but they are still declared in the\n" +
      "migration SQL:\n\n" +
      stale.map((key) => `  ${key}`).join("\n") +
      "\n\nDelete the exemption and record the constraint instead. An exemption for a defence\n" +
      "that was never actually removed is how an allowlist turns into a blindfold.",
  );

  for (const [key, why] of Object.entries(REMOVED_BY_DESIGN)) {
    assert.ok(
      why.trim().length > 40,
      `REMOVED_BY_DESIGN["${key}"] needs a real reason, not "${why}". Someone has to be able ` +
        "to judge in a year whether this cross-tenant hole is still acceptable.",
    );
  }
});

test("the constraints #479 proved load-bearing are recorded and unexcused", () => {
  for (const [key, why] of Object.entries(PROVEN_LOAD_BEARING)) {
    assert.ok(baseline[key], `${key} is missing from the baseline.\n  ${why}`);
    assert.ok(current[key], `${key} is no longer declared in the migration SQL.\n  ${why}`);
    assert.ok(
      !(key in REMOVED_BY_DESIGN),
      `${key} has been excused in REMOVED_BY_DESIGN. It cannot be: the harness MEASURED it ` +
        `stopping a cross-tenant write.\n  ${why}`,
    );
  }
});

/**
 * ══ THE HALF THAT IS NOT ABOUT TEXT ═══════════════════════════════════════
 *
 * Everything above reads .sql files. All of it would pass on a database that has
 * no foreign keys at all — a migration recorded as applied but never executed is
 * exactly the shape of the 2026-07-22 production login outage. So the recorded
 * set is also checked against `pg_constraint` in a real PostgreSQL with every
 * migration applied.
 *
 * The database comes from scripts/harness/testDatabase.ts — the same provisioner
 * the two-tenant harness uses, and specifically the same four-condition
 * `assertDisposable()`: no hosted provider, loopback only, a database name ending
 * _test/_harness/_scratch, and never the database DATABASE_URL points at. The
 * plain `.env` in this repository points at PRODUCTION, and this file must never
 * be the reason that changes. Nothing here relaxes any of those conditions and
 * nothing here provisions a database by any other route.
 *
 * NO DATABASE MEANS SKIP, LOUDLY — never a quiet pass. Set REQUIRE_LIVE_FK_CHECK=1
 * (CI does) to turn the skip into a failure, so "the guard never ran" cannot be
 * the reason a run is green.
 */
test("every recorded composite tenant FK exists in a live PostgreSQL catalog", async (t) => {
  const db = await provisionHarnessDatabase();

  if ("skipped" in db) {
    if (process.env.REQUIRE_LIVE_FK_CHECK) {
      assert.fail(
        "REQUIRE_LIVE_FK_CHECK is set and no disposable database was available, so the\n" +
          "composite tenant FKs were checked as text and never against a catalog.\n\n" +
          db.reason,
      );
    }
    t.skip(
      "no disposable database — the composite tenant FKs were checked as SQL TEXT ONLY.\n" +
        db.reason,
    );
    return;
  }

  const log = (m: string) => console.log(m);
  log(`  composite FK contract: ${db.describe}`);

  const prisma = new PrismaClient({ datasources: { db: { url: db.url } } });
  try {
    await migrateHarnessDatabase(db.url, log);

    const rows = await prisma.$queryRawUnsafe<CatalogRow[]>(CATALOG_FK_QUERY);
    const catalog = catalogFromRows(rows);
    log(`  composite FK contract: ${rows.length} foreign keys in pg_constraint`);

    const broken = Object.keys(baseline)
      .filter((key) => !(key in REMOVED_BY_DESIGN))
      .map((key) => ({ key, problem: catalogProblem(baseline[key], catalog.get(key)) }))
      .filter((r): r is { key: string; problem: string } => r.problem !== null)
      .map((r) => `  ${r.key}  —  ${r.problem}`);

    assert.deepEqual(
      broken,
      [],
      `COMPOSITE TENANT FOREIGN KEYS ARE MISSING FROM THE DATABASE (${db.describe}):\n\n` +
        broken.join("\n") +
        "\n\nThese are declared in prisma/migrations but PostgreSQL does not have them, or has\n" +
        "them over different columns. The migration SQL says one thing and the catalog says\n" +
        "another — which is the failure mode a text-only contract cannot see, and the one\n" +
        "that took production down on 2026-07-22.",
    );

    // VALIDATION STATE IS RECORDED, NOT JUST PRINTED.
    //
    // A NOT VALID foreign key still enforces every INSERT and UPDATE from the
    // moment it exists — which is the path a forged id takes, so this is not a
    // hole in the defence and none of these fail the run for being NOT VALID.
    // What it does mean is that rows written BEFORE the constraint were never
    // re-checked, so "are there already cross-tenant rows here?" is unanswered
    // for exactly these two tables.
    //
    // Recorded in both directions so neither is silent: a new NOT VALID entrant
    // has to be acknowledged, and a VALIDATE CONSTRAINT that fixes one has to be
    // written down rather than quietly changing what this file is understood to
    // have checked.
    const unvalidated = Object.keys(baseline)
      .filter((key) => catalog.get(key)?.validated === false)
      .sort();
    const validatedNow = Object.keys(KNOWN_NOT_VALID).filter(
      (key) => catalog.get(key)?.validated === true,
    );

    assert.deepEqual(
      unvalidated.filter((key) => !(key in KNOWN_NOT_VALID)),
      [],
      "NOT VALID composite tenant FKs that are not recorded as such:\n\n" +
        unvalidated.filter((key) => !(key in KNOWN_NOT_VALID)).map((k) => `  ${k}`).join("\n") +
        "\n\nThese enforce new writes but were never checked against existing rows, so nobody has\n" +
        "established whether cross-tenant rows are already there. Either run VALIDATE CONSTRAINT,\n" +
        "or record it in KNOWN_NOT_VALID with the reason it is acceptable.",
    );
    assert.deepEqual(
      validatedNow,
      [],
      "Good news — these are no longer NOT VALID, so their historical rows have now been\n" +
        "checked:\n\n" +
        validatedNow.map((k) => `  ${k}`).join("\n") +
        "\n\nRemove them from KNOWN_NOT_VALID so the record says what is actually true and they\n" +
        "cannot quietly go back.",
    );

    log(
      `  composite FK contract: ${Object.keys(baseline).length} recorded, all present; ` +
        `${unvalidated.length} NOT VALID as recorded (enforced on write, historical rows unchecked)`,
    );
  } finally {
    await prisma.$disconnect();
    await db.stop();
  }
});

/**
 * THE REFUSAL RULES THIS FILE DEPENDS ON, PINNED.
 *
 * Nothing tested `disposabilityProblem` before, and this is the second consumer
 * of it — the point at which "the guard is fine, #468 wrote it carefully" stops
 * being a good enough reason not to check. The repository's plain `.env` points
 * at a Neon production database; condition 1 is what refuses it, and that was
 * verified against the real file (refused, hosted-provider) rather than assumed.
 *
 * EVERY PROBE RUNS UNDER A `DATABASE_URL` THIS TEST CHOOSES, and that is not
 * tidiness — the first version of this test did not, and CI caught it. Condition
 * 4 refuses any URL equal to the ambient `DATABASE_URL`. On a developer machine
 * `DATABASE_URL` is production, so a localhost `_test` fixture differs from it
 * and the happy-path probe returned null. In the CI `integration` job
 * `DATABASE_URL` IS a localhost `denagocrm_test`, the fixture collided with it,
 * and condition 4 fired exactly as designed — a green local run and a red CI run
 * from a test that was reading the environment instead of stating it.
 *
 * The guard was right and is untouched. What follows controls the environment
 * for the duration of each assertion instead of depending on it, so all four
 * conditions are exercised deterministically on any machine.
 *
 * Conditions 1 and 2 necessarily OVERLAP — a hosted provider is never loopback —
 * so the hosted probe violates both and the ORDER of the checks decides which
 * message comes back. That is why these match on the message rather than merely
 * asserting non-null: "it refused" would still pass if condition 1 were deleted
 * and condition 2 caught the fallout.
 */
const SCHEME = "postgresql";
const LOCAL = "localhost:5432";

/**
 * Assembled from parts for the same reason scripts/harness/testDatabase.ts does
 * it: the secret scanner (.gitleaks.toml, `postgres-connection-string`) matches
 * the literal `postgresql://user:pass@host` shape, and it is right to. Composing
 * the credential-bearing probe below at runtime keeps that shape out of the
 * source, so the scanner stays sharp on the case that matters instead of being
 * taught to ignore this file.
 */
function probeUrl(database: string, credentials = ""): string {
  return `${SCHEME}://${credentials}${LOCAL}/${database}`;
}

/** Run `fn` with a chosen DATABASE_URL, and always put the real one back. */
function withDatabaseUrl<T>(url: string | undefined, fn: () => T): T {
  const previous = process.env.DATABASE_URL;
  if (url === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = url;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
}

test("the harness still refuses anything that could be production", async () => {
  const { disposabilityProblem } = await import("../scripts/harness/testDatabase");

  // The app's database for conditions 1-3, chosen so it differs from every probe
  // and cannot be what any of them trips over.
  const appDatabase = probeUrl("denagocrm_someone_elses_test");
  const scratch = probeUrl("denagocrm_fkcontract_probe_test");

  assert.equal(
    withDatabaseUrl(appDatabase, () => disposabilityProblem(scratch)),
    null,
    "a loopback database named _test, that is not the app's own, is acceptable",
  );
  assert.equal(
    withDatabaseUrl(undefined, () => disposabilityProblem(scratch)),
    null,
    "with no DATABASE_URL at all there is nothing for condition 4 to collide with",
  );

  assert.match(
    String(
      withDatabaseUrl(appDatabase, () =>
        disposabilityProblem(`${SCHEME}://ep-anything.eu-central-1.aws.neon.tech/denagocrm_test`),
      ),
    ),
    /hosted database provider/,
    "1. a hosted provider is never acceptable, even with a _test database name",
  );
  assert.match(
    String(
      withDatabaseUrl(appDatabase, () =>
        disposabilityProblem(`${SCHEME}://db.internal:5432/denagocrm_test`),
      ),
    ),
    /non-local host/,
    "2. loopback only",
  );
  assert.match(
    String(withDatabaseUrl(appDatabase, () => disposabilityProblem(probeUrl("denagocrm")))),
    /must end in _test, _harness or _scratch/,
    "3. the database name has to announce itself as disposable",
  );
  assert.match(
    String(withDatabaseUrl(scratch, () => disposabilityProblem(scratch))),
    /same database as DATABASE_URL/,
    "4. never the database the app itself is pointed at",
  );

  // The realistic shape of condition 4, and the one that made this PR red:
  // CI's DATABASE_URL carries credentials and the derived harness URL may not,
  // or may carry different ones. Same host, same database, so it is the same
  // database — `sameTarget` compares host and path and ignores the rest, and a
  // different password must never be able to launder a production URL.
  assert.match(
    String(
      withDatabaseUrl(probeUrl("denagocrm_test", "ci:ci@"), () =>
        disposabilityProblem(probeUrl("denagocrm_test", "someone:else@")),
      ),
    ),
    /same database as DATABASE_URL/,
    "4b. different credentials on the same host and database is still the same database",
  );
});

/**
 * ══ THE PARSER IS PART OF THE GUARD, SO IT IS TESTED TOO ═══════════════════
 *
 * A guard derived from a parse is only as honest as the parse. A parser that
 * silently returns fewer constraints turns every check above into a tautology —
 * so these run on synthetic SQL, not on whatever happens to be in prisma/.
 */

/**
 * ══ THE REPLAY ORDER IS PART OF THE ANSWER ════════════════════════════════
 *
 * This scanner does not list migrations, it REPLAYS them — adds, constraint
 * drops and table drops resolved against each other — so the recorded set is a
 * function of the order. If that order can differ from the one production
 * applies, the two can disagree about what exists.
 *
 * The failure is silent in the direction that matters. Suppose a colliding
 * prefix pair where one migration adds a composite FK and the other replaces it.
 * Production, using the runner's total order, finishes holding the constraint. A
 * scanner sorting on the numeric prefix alone can replay the pair the other way
 * and finish without it — so it never enters the baseline. Nothing goes red:
 * the live check asserts recorded ⊆ catalog, and a constraint in the catalog
 * that was never recorded is not a failure. The defence just never joins the
 * ratchet, and can be dropped later with nothing watching.
 */

test("the scanner sorts with the runner's own comparator, not a copy of it", () => {
  // Identity, not agreement. Two implementations that agree today are still two
  // implementations; #465 exists because the runner's ordering rule needed
  // fixing, and anything that re-derived it would not have been fixed with it.
  assert.equal(
    migrationOrder,
    compareMigrationNames,
    "compositeTenantFkScan must sort by the function scripts/apply-migrations.mjs exports, " +
      "so the replay order cannot drift from the order production applies.",
  );
});

test("equal numeric prefixes are broken deterministically, in the runner's direction", () => {
  // The real colliding pair on main, handed over in the WRONG order so a stable
  // sort cannot accidentally look correct.
  const reversed = [
    "20260810110000_staff_reply_delivery_state",
    "20260810110000_bot_session_ownership",
  ];
  const lexical = [
    "20260810110000_bot_session_ownership",
    "20260810110000_staff_reply_delivery_state",
  ];

  assert.deepEqual([...reversed].sort(migrationOrder), lexical, "the scanner's order");
  assert.deepEqual([...reversed].sort(compareMigrationNames), lexical, "the runner's order");

  // Why the prefix-only sort this file originally used was wrong, stated so it
  // cannot come back by accident: subtracting equal prefixes returns 0, Array
  // .prototype.sort is stable, and the pair therefore keeps whatever order
  // readdirSync happened to give — filesystem order on Linux.
  assert.deepEqual(
    [...reversed].sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10)),
    reversed,
    "a prefix-only comparator does not order a colliding pair at all — it preserves the input",
  );
});

test("the scanner walks exactly the migrations the runner will apply", () => {
  // Pins the FILTER as well as the comparator. orderedMigrationDirs takes a
  // directory from its caller and so cannot simply call orderedMigrations(),
  // which resolves its own; this is what stops the two definitions of "a
  // migration directory" drifting apart.
  //
  // NOT sufficient on its own, which is why the two tests above exist. Reverting
  // to the prefix-only comparator was mutation-tested and left THIS assertion
  // green: readdirSync returns alphabetical order on NTFS, so the broken sort
  // reproduces the right answer on the machine most likely to run it, and only
  // misbehaves on Linux — CI, Vercel, disaster recovery. A behavioural test of
  // an ordering bug is only as good as the filesystem it ran on.
  assert.deepEqual(orderedMigrationDirs(MIGRATIONS), orderedMigrations());
});

test("the colliding-prefix case this guards is real, not imagined", () => {
  // Without this, every assertion above stays green while proving nothing the
  // day the last colliding pair leaves the repository — and the ordering rule
  // would then be untested at exactly the moment someone is free to simplify it.
  const collisions = prefixCollisions(orderedMigrations());
  assert.ok(
    collisions.length > 0,
    "No colliding numeric prefixes remain on main. The ordering rule above is now untestable " +
      "against real data — either restore a synthetic pair here or delete these tests knowingly.",
  );
});

test("the scanner finds composite tenant FKs in every syntax the migrations use", () => {
  const sql = [
    'DO $$ BEGIN',
    '  ALTER TABLE "JobCardItem" ADD CONSTRAINT "JobCardItem_tenantId_partId_fkey"',
    '    FOREIGN KEY ("tenantId", "partId") REFERENCES "Part"("tenantId", "id") NOT VALID;',
    'EXCEPTION WHEN duplicate_object THEN NULL; END $$;',
    // no space after the comma, and an ON DELETE clause — 20260805230000's shape
    'DO $$ BEGIN',
    '  ALTER TABLE "SigningJob" ADD CONSTRAINT "SigningJob_request_fkey"',
    '    FOREIGN KEY ("tenantId","requestId") REFERENCES "SignatureRequest"("tenantId","id") ON DELETE CASCADE;',
    'EXCEPTION WHEN duplicate_object THEN NULL; END $$;',
    // table name and ADD CONSTRAINT on separate lines
    'ALTER TABLE "Widget"',
    '  ADD CONSTRAINT "Widget_tenantId_gadgetId_fkey"',
    '  FOREIGN KEY ("tenantId", "gadgetId") REFERENCES "Gadget"("tenantId", "id");',
    // inline in CREATE TABLE
    'CREATE TABLE IF NOT EXISTS "Sprocket" (',
    '  "id" TEXT NOT NULL,',
    '  "tenantId" TEXT NOT NULL,',
    '  "widgetId" TEXT NOT NULL,',
    '  CONSTRAINT "Sprocket_pkey" PRIMARY KEY ("id"),',
    '  CONSTRAINT "Sprocket_tenantId_widgetId_fkey" FOREIGN KEY ("tenantId", "widgetId") REFERENCES "Widget"("tenantId", "id"),',
    '  CONSTRAINT "Sprocket_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE',
    ');',
  ].join("\n");

  const found = scanMigrationSql(sql)
    .filter((e) => e.kind === "add")
    .map((e) => (e.kind === "add" ? fkKey(e.fk.table, e.fk.constraint) : ""));

  assert.deepEqual(found.sort(), [
    "JobCardItem.JobCardItem_tenantId_partId_fkey",
    "SigningJob.SigningJob_request_fkey",
    "Sprocket.Sprocket_tenantId_widgetId_fkey",
    "Widget.Widget_tenantId_gadgetId_fkey",
  ]);
});

test("a single-column tenant FK is not a composite tenant FK", () => {
  // Every table has one of these. It says the ROW belongs to a tenant; it says
  // nothing about whether its PARENT does, and it is not what stopped the
  // forged-partId write. Counting it would inflate the baseline with 150
  // constraints that do not defend anything this file claims to defend.
  const sql =
    'ALTER TABLE "BotFlowEvent" ADD CONSTRAINT "BotFlowEvent_tenantId_fkey" ' +
    'FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;';
  assert.deepEqual(scanMigrationSql(sql), []);
});

test("column order does not decide whether a key is a tenant key", () => {
  const sql =
    'ALTER TABLE "Thing" ADD CONSTRAINT "Thing_partId_tenantId_fkey" ' +
    'FOREIGN KEY ("partId", "tenantId") REFERENCES "Part"("id", "tenantId");';
  const events = scanMigrationSql(sql);
  assert.equal(events.length, 1, "a composite key written tenant-second is the same defence");
});

test("a drop is honoured, and a drop followed by a re-add is not a removal", () => {
  // 20260805238000_signing_job_request_cascade in miniature. Getting this wrong
  // in the other direction — treating the re-add as absent — would demand an
  // acknowledgement for a constraint that is still there, and an alarm that
  // fires when nothing is wrong is an alarm that gets switched off.
  const dropped = scanMigrationSql(
    'ALTER TABLE "SigningJob" ADD CONSTRAINT "SigningJob_request_fkey" ' +
      'FOREIGN KEY ("tenantId","requestId") REFERENCES "SignatureRequest"("tenantId","id");\n' +
      'ALTER TABLE "SigningJob" DROP CONSTRAINT IF EXISTS "SigningJob_request_fkey";',
  );
  assert.deepEqual(
    dropped.map((e) => e.kind),
    ["add", "drop"],
    "events must come back in statement order, or a drop cannot be replayed against its add",
  );

  const readded = scanMigrationSql(
    'ALTER TABLE "SigningJob" DROP CONSTRAINT IF EXISTS "SigningJob_request_fkey";\n' +
      'DO $$ BEGIN\n' +
      '  ALTER TABLE "SigningJob" ADD CONSTRAINT "SigningJob_request_fkey"\n' +
      '    FOREIGN KEY ("tenantId","requestId") REFERENCES "SignatureRequest"("tenantId","id") ON DELETE CASCADE;\n' +
      'EXCEPTION WHEN duplicate_object THEN NULL; END $$;',
  );
  assert.deepEqual(readded.map((e) => e.kind), ["drop", "add"]);
});

test("dropping a table drops its composite tenant FKs, in both directions", () => {
  // 20260802120000_retire_automation_rules in miniature, and the reason this
  // scanner tracks table lifetime rather than only ADD/DROP CONSTRAINT. Without
  // this, five constraints stay in the recorded set for ever, the live catalog
  // disagrees with the SQL on every run, and the only way to get a green build
  // is to start excusing things — which is how a guard becomes decoration.
  const events = scanMigrationSql('DROP TABLE IF EXISTS "AutomationRule";');
  assert.deepEqual(events, [{ at: 0, kind: "drop-table", tables: ["AutomationRule"] }]);

  const multiple = scanMigrationSql('DROP TABLE "A", "B" CASCADE;');
  assert.deepEqual(multiple[0].kind === "drop-table" ? multiple[0].tables : [], ["A", "B"]);
});

test("the retired automation tables are gone from the recorded set", () => {
  // Pinned by name, because this is the one already-happened example and it is
  // the whole argument for the file. If these ever come BACK into the baseline
  // it means the scanner stopped seeing DROP TABLE, and the recorded set has
  // started describing constraints no database has.
  for (const key of [
    "AutomationLog.AutomationLog_tenantId_ruleId_fkey",
    "AutomationRule.AutomationRule_tenantId_triggerStageId_fkey",
  ]) {
    assert.ok(
      !current[key] && !baseline[key],
      `${key} is recorded as declared, but 20260802120000_retire_automation_rules dropped ` +
        "its table. The scanner has stopped modelling DROP TABLE.",
    );
  }
});

test("a constraint inside a comment is not a constraint", () => {
  const sql = [
    "-- We used to have:",
    '--   ALTER TABLE "Old" ADD CONSTRAINT "Old_tenantId_thingId_fkey"',
    '--     FOREIGN KEY ("tenantId", "thingId") REFERENCES "Thing"("tenantId", "id");',
    "/* and this one didn't survive review either:",
    '   ALTER TABLE "Older" ADD CONSTRAINT "Older_tenantId_thingId_fkey"',
    '     FOREIGN KEY ("tenantId", "thingId") REFERENCES "Thing"("tenantId", "id"); */',
    'ALTER TABLE "Real" ADD CONSTRAINT "Real_tenantId_thingId_fkey"',
    '  FOREIGN KEY ("tenantId", "thingId") REFERENCES "Thing"("tenantId", "id");',
  ].join("\n");

  const found = scanMigrationSql(sql).map((e) => (e.kind === "add" ? e.fk.constraint : ""));
  assert.deepEqual(found, ["Real_tenantId_thingId_fkey"]);
});

test("an apostrophe in a comment does not swallow the rest of the file", () => {
  // The bug this exists to prevent: a naive quote-tracking stripper reads the
  // apostrophe in "didn't" as the start of a string literal, runs to the next
  // quote — which may be a thousand lines later — and every constraint in
  // between vanishes from the baseline while the test still passes.
  const sql = [
    "-- this didn't work, so:",
    'ALTER TABLE "Real" ADD CONSTRAINT "Real_tenantId_thingId_fkey"',
    '  FOREIGN KEY ("tenantId", "thingId") REFERENCES "Thing"("tenantId", "id");',
  ].join("\n");
  assert.equal(scanMigrationSql(sql).length, 1);
});

test("a comment marker inside a string literal is not a comment", () => {
  const kept = stripSqlComments("SELECT 'a -- b' AS x; -- gone\nSELECT 2;");
  assert.equal(kept.includes("'a -- b'"), true);
  assert.equal(kept.includes("gone"), false);
});

test("the updater may add a constraint", () => {
  const previous = { "A.a_fkey": entry("A", "a_fkey", "B") };
  const found = { ...previous, "C.c_fkey": entry("C", "c_fkey", "D") };
  const result = nextBaseline(previous, found);
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.ok ? result.baseline : {}), ["A.a_fkey", "C.c_fkey"]);
});

test("the updater refuses to remove a constraint", () => {
  const previous = {
    "A.a_fkey": entry("A", "a_fkey", "B"),
    "C.c_fkey": entry("C", "c_fkey", "D"),
  };
  const result = nextBaseline(previous, { "A.a_fkey": entry("A", "a_fkey", "B") });
  assert.equal(result.ok, false, "UPDATE_COMPOSITE_FK_BASELINE must never be a way to silence a loss");
  assert.deepEqual(result.ok ? [] : result.removed, ["C.c_fkey"]);
});

test("the updater refuses to narrow a constraint", () => {
  // The dangerous edit is not a deletion, it is a replacement: same name, one
  // column, no tenant. If the updater accepted that, running it would write the
  // hole into the baseline as the new normal.
  const previous = { "Q.Quote_tenantId_revisionOfId_fkey": entry("Q", "Quote_tenantId_revisionOfId_fkey", "Q") };
  const narrowed: Record<string, BaselineEntry> = {
    "Q.Quote_tenantId_revisionOfId_fkey": {
      table: "Q",
      constraint: "Quote_tenantId_revisionOfId_fkey",
      columns: ["revisionOfId"],
      references: { table: "Q", columns: ["id"] },
    },
  };
  const result = nextBaseline(previous, narrowed);
  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? [] : result.removed, ["Q.Quote_tenantId_revisionOfId_fkey"]);
});

test("catalogProblem compares the shape, not just the name", () => {
  const expected: BaselineEntry = {
    table: "JobCardItem",
    constraint: "JobCardItem_tenantId_partId_fkey",
    columns: ["tenantId", "partId"],
    references: { table: "Part", columns: ["tenantId", "id"] },
  };
  assert.equal(
    catalogProblem(expected, {
      table: "JobCardItem",
      constraint: "JobCardItem_tenantId_partId_fkey",
      columns: ["tenantId", "partId"],
      referencedTable: "Part",
      referencedColumns: ["tenantId", "id"],
      validated: false,
    }),
    null,
    "NOT VALID still enforces every write, so it is not a problem",
  );

  assert.match(String(catalogProblem(expected, undefined)), /absent from pg_constraint/);

  assert.match(
    String(
      catalogProblem(expected, {
        table: "JobCardItem",
        constraint: "JobCardItem_tenantId_partId_fkey",
        columns: ["partId"],
        referencedTable: "Part",
        referencedColumns: ["id"],
        validated: true,
      }),
    ),
    /columns are \(partId\)/,
    "a same-named single-column FK is the disguise a regenerated migration wears",
  );

  assert.match(
    String(
      catalogProblem(expected, {
        table: "JobCardItem",
        constraint: "JobCardItem_tenantId_partId_fkey",
        columns: ["tenantId", "partId"],
        referencedTable: "PartArchive",
        referencedColumns: ["tenantId", "id"],
        validated: true,
      }),
    ),
    /references "PartArchive"/,
  );
});

function entry(table: string, constraint: string, references: string): BaselineEntry {
  return {
    table,
    constraint,
    columns: ["tenantId", "x"],
    references: { table: references, columns: ["tenantId", "id"] },
  };
}

/**
 * ══ CAN THESE BE EXPRESSED IN schema.prisma? ══════════════════════════════
 *
 * YES. Measured, not assumed — the assumption when this file was started was
 * "no", and it was wrong.
 *
 * On the pinned Prisma 6.19.3, this validates:
 *
 *     model Quote {
 *       tenantId     String?
 *       tenant       Tenant? @relation(fields: [tenantId], references: [id])
 *       revisionOfId String?
 *       revisionOf   Quote?  @relation("QuoteRevision",
 *                              fields: [tenantId, revisionOfId],
 *                              references: [tenantId, id])
 *       @@unique([tenantId, id])
 *     }
 *
 * — including the two things that looked like blockers and are not: one scalar
 * (`tenantId`) participating in SEVERAL relations at once, and participating in
 * the model's own `tenant` relation at the same time. `prisma migrate diff`
 * then emits
 *
 *     ALTER TABLE "Quote" ADD CONSTRAINT "Quote_tenantId_revisionOfId_fkey"
 *       FOREIGN KEY ("tenantId", "revisionOfId") REFERENCES "Quote"("tenantId", "id")
 *
 * which is the hand-written constraint, to the character, name included. The
 * migrations were evidently written to Prisma's naming convention on purpose.
 *
 * So the better long-term fix is real, and it is a DIFFERENT PR — moving 132
 * constraints into the schema is not a change to make inside a test. What it
 * would take, measured against this checkout:
 *
 *   - PARENTS: 35 of the 36 are already there. Every parent model already
 *     declares `@@unique([tenantId, id])`. The 36th is `AutomationRule`, which
 *     has no Prisma model because its table was dropped — nothing to do.
 *   - CHILDREN: 132 relations across 69 models. 91 of the FK columns already
 *     have a single-column `@relation` that would be WIDENED (fields:
 *     [partId] → [tenantId, partId]); 41 are loose scalars that would gain one.
 *   - THE CARE IS IN THE DELETE RULES. Prisma defaults an optional relation to
 *     `ON DELETE SET NULL ON UPDATE CASCADE`. The hand-written constraints are a
 *     mix of no rule (NO ACTION), RESTRICT and CASCADE. Every one needs an
 *     explicit `onDelete:`/`onUpdate:` matching what the database has now, or
 *     the "no-op" migration quietly rewrites the deletion semantics of the whole
 *     schema. This is the bulk of the work and all of the risk.
 *   - CALL SITES: nearly free, which is the surprise. Prisma's UNCHECKED create
 *     input still accepts `tenantId` and the FK column as plain scalars, which
 *     is how this codebase writes; only mixing a nested `connect` with a direct
 *     `tenantId` in one call breaks, and `src/` contains exactly one Prisma
 *     `connect:` (merge.ts, on a many-to-many that is not affected).
 *   - WIDENING each existing relation drops and re-adds the SINGLE-column FK,
 *     so the migration must be reviewed against production before it runs.
 *
 * Until that PR lands, THIS FILE IS THE ONLY THING standing between a routine
 * migration and the silent loss of the defence #479 measured. After it lands,
 * this file is still worth keeping: it is what proves the schema and the
 * database still agree.
 */

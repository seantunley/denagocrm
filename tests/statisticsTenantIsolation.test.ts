import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  statisticsRowVisible,
  statisticsScopeFor,
  statisticsScopeSql,
  statisticsScopeWhere,
} from "../src/lib/statisticsTenantRule";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

/**
 * These tests EXECUTE the reporting rollup's ownership decision with two concrete
 * tenant ids.
 *
 * `reportingStatistics.test.ts` runs the real rollup and asserts on the SQL it
 * builds, which is the behavioural half. This is the other half, and it is the
 * one that survives the rollup being rewritten: a rule is a decision about WHO IS
 * EXCLUDED, and a test that only checks a predicate is PRESENT would pass just as
 * happily against a rule that resolved every caller to the founding tenant and
 * leaked every workspace.
 *
 * `src/lib/statistics.ts` cannot be imported from `node:test` — it starts with
 * `import "server-only"` and pulls in a live PrismaClient — so the decision lives
 * in `statisticsTenantRule.ts`, which imports only the `Prisma` SQL tag.
 */

const TENANT_A = DEFAULT_TENANT_ID; // the founding workspace
const TENANT_B = "tenant_second_dealer";

type Row = { id: string; tenantId: string | null };

/**
 * Source rows as the two aggregated tables hold them. The un-owned row is the
 * whole point: production has no such Lead or JobCard today, and this suite
 * exists to keep it true that one could never be counted as somebody's.
 */
const TABLE: Row[] = [
  { id: "lead_a_won", tenantId: TENANT_A },
  { id: "lead_a_lost", tenantId: TENANT_A },
  { id: "lead_b_won", tenantId: TENANT_B },
  { id: "lead_unowned", tenantId: null },
];

/** What `SELECT ... WHERE <scope>` returns, decided by the same rule the SQL encodes. */
const selectAs = (tenantId: string) =>
  TABLE.filter((row) => statisticsRowVisible(row.tenantId, statisticsScopeFor({ tenantId }))).map(
    (row) => row.id,
  );

/* ── the boundary, exercised rather than pattern-matched ───────────────── */

test("tenant B's lead is unreachable from tenant A, and A's from B", () => {
  assert.deepEqual(selectAs(TENANT_A), ["lead_a_won", "lead_a_lost"]);
  assert.deepEqual(selectAs(TENANT_B), ["lead_b_won"]);

  // Stated as the property, not just the expected list: no row a workspace does
  // not own may appear in its aggregate, for any pair of workspaces.
  for (const acting of [TENANT_A, TENANT_B, "tenant_third"]) {
    for (const id of selectAs(acting)) {
      const row = TABLE.find((candidate) => candidate.id === id)!;
      assert.equal(
        row.tenantId,
        acting,
        `${acting} can reach ${id}, owned by ${String(row.tenantId)}`,
      );
    }
  }

  // A workspace with no rows aggregates NOTHING — never "everything", which is
  // what an absent predicate degrades to and what makes this failure quiet: an
  // aggregate carries no recognisable foreign record, just a wrong total.
  assert.deepEqual(selectAs("tenant_third"), []);
});

test("an un-owned source row belongs to NOBODY — the founding tenant included", () => {
  // The rule this replaces was `tenantId = $1 OR tenantId IS NULL` for the
  // founding tenant. Both source tables were backfilled unconditionally in July
  // (Lead by 20260722120000, JobCard by 20260722142000), so a NULL row today was
  // written AFTER its backfill by a live code path — it is not "old", it is
  // "owned by an unknown workspace", and could be tenant B's.
  assert.equal(statisticsRowVisible(null, statisticsScopeFor({ tenantId: TENANT_A })), false);
  assert.equal(statisticsRowVisible(null, statisticsScopeFor({ tenantId: TENANT_B })), false);
  assert.equal(statisticsRowVisible(undefined, statisticsScopeFor({ tenantId: TENANT_A })), false);
  assert.equal(statisticsScopeFor({ tenantId: TENANT_A }).includeUnowned, false);
  assert.ok(!selectAs(TENANT_A).includes("lead_unowned"));
});

test("the founding tenant is not a special case at all", () => {
  // The old rule branched on `tenantId === DEFAULT_TENANT_ID`. If any branch on
  // the founding id comes back, this is what notices: the two scopes must differ
  // only in the tenant they name.
  const founding = statisticsScopeFor({ tenantId: TENANT_A });
  const second = statisticsScopeFor({ tenantId: TENANT_B });
  assert.equal(founding.includeUnowned, second.includeUnowned);
  assert.deepEqual({ ...founding, tenantId: "x" }, { ...second, tenantId: "x" });
});

/* ── the emitted SQL, so it cannot drift from the decision above ───────── */

const sqlOf = (tenantId: string) => {
  const query = statisticsScopeSql(statisticsScopeFor({ tenantId }));
  return { text: query.sql, values: query.values };
};

test("the SQL the database runs is the rule, not a paraphrase of it", () => {
  for (const tenantId of [TENANT_A, TENANT_B]) {
    const { text, values } = sqlOf(tenantId);
    assert.deepEqual(values, [tenantId], "exactly one bound value: the tenant being rolled up");
    assert.match(text, /AND "tenantId" = \?::text/);
    // NAMED BY COLUMN, deliberately. `"deletedAt" IS NULL` is in every aggregate
    // this fragment is spliced into and has to be — without it a trashed lead
    // counts for ever — so a bare /IS NULL/ assertion would be testing the
    // soft-delete filter and reporting it as a tenant leak.
    assert.ok(
      !/"tenantId" IS NULL/.test(text),
      `the founding tenant must not be handed the un-owned rows: ${text}`,
    );
  }

  // The SQL and the in-memory decision are the same rule: an `IS NULL` term
  // appears if and ONLY if the scope admits un-owned rows. Reinstating the
  // fallback in one place and not the other is then not expressible.
  for (const includeUnowned of [true, false]) {
    const query = statisticsScopeSql({ tenantId: TENANT_A, includeUnowned });
    assert.equal(
      /"tenantId" IS NULL/.test(query.sql),
      includeUnowned,
      "the SQL must admit un-owned rows exactly when the scope says it does",
    );
    assert.equal(statisticsRowVisible(null, { tenantId: TENANT_A, includeUnowned }), includeUnowned);
  }
});

test("the change probe watches exactly the rows the aggregate counts", () => {
  // `findSourceRow` reads through the Prisma client, the aggregate reads raw SQL.
  // If the two disagreed about ownership, a change to a row one can see and the
  // other cannot would either never be noticed or be recomputed for ever.
  for (const tenantId of [TENANT_A, TENANT_B]) {
    const where = statisticsScopeWhere(statisticsScopeFor({ tenantId }));
    assert.deepEqual(where, { tenantId }, "strict equality, with no OR to widen it");
    assert.ok(!("OR" in where), "a second workspace must never inherit the un-owned rows");
  }

  // Same equivalence as the SQL: the fragment admits un-owned rows exactly when
  // the scope does.
  const permissive = statisticsScopeWhere({ tenantId: TENANT_A, includeUnowned: true });
  assert.deepEqual(permissive, { OR: [{ tenantId: TENANT_A }, { tenantId: null }] });
});

/* ── wiring: the decision only matters if statistics.ts consumes it ────── */

test("statistics.ts builds every source predicate from the shared rule", () => {
  const code = src("src/lib/statistics.ts");
  assert.match(code, /from "\.\/statisticsTenantRule"/, "the rule must not be re-implemented here");
  // The rule is a delegation, not a copy: no NULL-tenant term may be spelled out
  // in the rollup itself, and no branch on the founding tenant id may decide a
  // predicate.
  assert.ok(
    !/"tenantId" IS NULL/.test(code),
    "statistics.ts must not spell out a NULL-tenant predicate of its own",
  );
  assert.ok(
    !/tenantId === DEFAULT_TENANT_ID/.test(code),
    "no query may branch on whether the caller is the founding tenant",
  );
  // Both raw aggregates and the keyset probe go through it.
  assert.match(code, /\$\{tenantSql\(tenantId\)\}/);
  assert.match(code, /where: \{ AND: \[tenantWhere\(tenantId\), where\] \}/);
});

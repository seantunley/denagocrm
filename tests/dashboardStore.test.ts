import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { LIMITS, parseConfig, parseConfigStrict } from "../src/lib/dashboard/config";
import { DEFAULT_LAYOUT, cardById } from "../src/lib/dashboard/registry";

/**
 * Guards for user-built dashboards: the store (read), the config actions
 * (write), and the migration that creates the table and carries the old layouts
 * forward.
 *
 * WHY SO MUCH OF THIS READS SOURCE RATHER THAN CALLING IT. There is no database
 * in the unit suite, and both halves of this feature import `server-only` and a
 * PrismaClient, so neither can be imported here at all — the same position
 * `tests/dashboardCards.test.ts` is in for the layout read and write, and these
 * are written in that style. What a source contract can still pin is precisely
 * the class of defect that matters here, because it is a property of the SHAPE of
 * the code rather than of any one result:
 *
 *   - a user id arriving from OUTSIDE the session, which is how one person's
 *     dashboard gets served or overwritten from another's request;
 *   - a migration that drops something, which is how a bad release stops being
 *     revertible;
 *   - a migration name that sorts wrong, or an index built CONCURRENTLY, either
 *     of which fails the deploy rather than the test.
 *
 * The pure parts — that the config the backfill writes and the config the default
 * builds are ones the app can actually read — are exercised for real, against the
 * real parser, because config.ts and registry.ts are deliberately free of Prisma.
 */

const root = path.join(__dirname, "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const STORE = "src/lib/dashboard/store.ts";
const ACTIONS = "src/app/actions/dashboardConfig.ts";
const MIGRATION_NAME = "20260805140000_dashboard_config";
const LAYOUT_MIGRATION_NAME = "20260804100000_dashboard_layout";
const MIGRATION = `prisma/migrations/${MIGRATION_NAME}/migration.sql`;

/** Every `export async function name(params)` in a file, params captured. */
function exportedFunctions(source: string): { name: string; params: string }[] {
  return [...source.matchAll(/export async function (\w+)\(([^)]*)\)/g)].map((m) => ({
    name: m[1],
    params: m[2],
  }));
}

/** The body of each exported action, for per-export assertions. */
function exportBodies(source: string): string[] {
  return source.split(/export async function /).slice(1);
}

/**
 * The executable part of a file: comments stripped, and every function's
 * PARAMETER LIST blanked out.
 *
 * Both removals are needed and both are about false positives, which are the way
 * a source contract stops being maintained. `userId: string` in a helper's
 * signature and `userId: user.id` in a Prisma argument look identical to a
 * regex, and so do `config: unknown` and `config: validated(...)` — declaring a
 * parameter is how the value legitimately gets in, whereas what these guards look
 * for is a value SUPPLIED from somewhere it should not be, which only happens in
 * an object literal. And these files argue at length, in prose, about exactly the
 * rules being checked; a guard that reads the explanation as the offence fails on
 * the file that is doing the right thing.
 */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/function \w+\([^)]*\)/g, "function ()");
}

/* ── nothing here can be asked about another user ─────────────────── */

test("no exported action accepts a user id", () => {
  // A server action is reachable by direct POST. A `userId` in the payload — by
  // that name or any other — is an invitation to write, or read back, somebody
  // else's dashboard, and no amount of care further down makes up for accepting
  // one. Dashboards are addressed by SLUG, which is meaningless outside the
  // caller's own rows.
  const actions = src(ACTIONS);
  const exported = exportedFunctions(actions);
  assert.deepEqual(
    exported.map((f) => f.name).sort(),
    [
      "createDashboard",
      "deleteDashboard",
      "renameDashboard",
      "reorderDashboards",
      "saveDashboardConfig",
      "setDashboardShared",
      "takeControl",
    ],
    "the set of exported dashboard-config actions changed — check the new one too",
  );
  for (const { name, params } of exported) {
    assert.ok(
      !/user/i.test(params),
      `${name} takes a parameter mentioning "user" — the acting user must come from the session`,
    );
    assert.ok(
      !/\bid\b|Id\b/.test(params),
      `${name} takes an id parameter; dashboards are addressed by slug, scoped to the caller`,
    );
  }
});

test("every exported action resolves the acting user from the session", () => {
  const actions = src(ACTIONS);
  const bodies = exportBodies(actions);
  assert.equal(bodies.length, 7, "unexpected number of exported actions");
  for (const body of bodies) {
    // requireOwner and requireTenantOwner are requireUser plus an entitlement
    // check — they resolve the SAME session user and then refuse. Publishing is
    // restricted to the owner OF THE ACTIVE WORKSPACE (requireTenantOwner: the
    // platform role, or Tenant.ownerUserId), which is the stricter of the two,
    // not a way around this rule.
    assert.match(
      body,
      /const user = await require(User|Owner|TenantOwner)\(\);/,
      `${body.slice(0, body.indexOf("("))} does not resolve the acting user from the session`,
    );
  }
});

test("the only user id that ever reaches a query is the session user's", () => {
  const actions = src(ACTIONS);
  // Explicit `userId:` values in a Prisma argument. Shorthand (`{ userId }`
  // inside a helper that received it as a parameter) is how the id gets in and is
  // fine; what must never appear is a userId sourced from anywhere else.
  const assigned = [...codeOf(actions).matchAll(/userId:\s*([A-Za-z0-9_.]+)/g)].map(
    (m) => m[1],
  );
  assert.ok(assigned.length >= 3, "expected the actions to filter and stamp userId");
  for (const value of assigned) {
    assert.equal(value, "user.id", "a userId other than the session user's reached a query");
  }
  // And the helpers that DO take a userId are only ever handed that same value.
  const handed = [...actions.matchAll(/await (ownDashboard|ownCount|freeSlug)\(([^,)]*)/g)];
  assert.ok(handed.length >= 4, "expected the actions to resolve rows through the scoped helpers");
  for (const [, helper, arg] of handed) {
    assert.equal(arg.trim(), "user.id", `${helper} was called with something other than user.id`);
  }
});

test("the store's reads are keyed on the session user and take no user id", () => {
  const store = src(STORE);
  // The read path is called from server components whose props come from a URL.
  // A function here that accepted a user id would let one person's screen be
  // addressed by another; `dashboardBySlug` takes a slug, which only ever
  // narrows a set already scoped to the caller.
  assert.match(
    store,
    /export const dashboardsForViewer = cache\(async \(\): Promise/,
    "dashboardsForViewer must take NO parameters",
  );
  assert.match(
    store,
    /export const dashboardBySlug = cache\(async \(slug: string\): Promise/,
    "dashboardBySlug must take a slug and nothing else",
  );
  assert.ok(
    !/cache\(async \([^)]*user/i.test(store),
    "no cached read may take a user parameter",
  );
  /*
   * THIS RULE CHANGED WHEN SHARING ARRIVED, and it is worth being exact about
   * how, because the old wording forbade the new feature outright.
   *
   * It used to be "every read is filtered by the session user's own id", which
   * was right while dashboards were personal. A dashboard published to the
   * workspace is by definition somebody else's, so the read that finds one
   * cannot be filtered by the viewer's id.
   *
   * What must NOT change is that no read is unscoped. So the rule is now: every
   * read is either the caller's OWN rows, or restricted to PUBLISHED ones. A
   * query matching neither would return other people's private dashboards, which
   * is the thing this test exists to prevent.
   */
  const reads = store.split("prisma.dashboard.").slice(1);
  assert.equal(reads.length, 3, "expected three database reads in the store");
  for (const read of reads) {
    const own = /userId: user\.id/.test(read);
    // "Published" is `sharedInTenant(...)` now — the bare `sharedAt: { not: null }`
    // it replaced matched every TENANT's published rows, not just this one's.
    const published = /sharedInTenant\(/.test(read);
    assert.ok(
      own || published,
      `a store query is scoped to neither the caller nor published rows: ${read.slice(0, 120)}`,
    );
  }
  assert.equal(
    (store.match(/const \{ user \} = await dashboardViewer\(\);/g) ?? []).length,
    2,
    "every read must take its user from the session-resolved viewer",
  );
});

test("the read path never writes, so the default is not silently materialised", () => {
  // The whole point of `defaultDashboard()` is that a user who has not taken
  // control has NO row, so the default keeps following the card catalogue as
  // releases change it. A store that seeded a row on first read would freeze
  // every existing user's screen at whatever the catalogue held that day.
  const store = src(STORE);
  for (const op of ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]) {
    assert.ok(
      !new RegExp(`prisma\\.\\w+\\.${op}\\b`).test(store),
      `the store calls prisma…${op} — the read path must not write`,
    );
  }
  assert.match(
    store,
    /export function defaultDashboard\(\): LoadedDashboard \{/,
    "defaultDashboard must be a plain pure function, not a database read",
  );
});

/* ── configs cannot be stored unvalidated ─────────────────────────── */

test("every config written goes through the strict parser", () => {
  const actions = src(ACTIONS);
  // One door. `validated()` is the only producer of a value for the `config`
  // column and it always runs parseConfigStrict first, so a config the renderer
  // cannot read cannot be stored — and the parser's own message, written for the
  // person who typed it, is what the user sees.
  assert.match(
    actions,
    /function validated\(config: unknown\): Prisma\.InputJsonValue \{\s*const parsed = parseConfigStrict\(config\);\s*if \(!parsed\.ok\) refuse\(parsed\.error\);/,
    "validated() must strict-parse and refuse with the parser's own message",
  );
  const written = [...codeOf(actions).matchAll(/\bconfig:\s*([A-Za-z0-9_.]+\(?)/g)]
    .map((m) => m[1])
    // `config: true` is Prisma's projection syntax inside a `select` — a READ of
    // the column, which is what ownDashboard does. Only supplied VALUES are
    // writes, and those are what this guard is about.
    .filter((value) => value !== "true");
  assert.ok(written.length >= 3, "expected the actions to write a config in several places");
  for (const value of written) {
    assert.equal(
      value,
      "validated(",
      "a config reached the database without going through validated()",
    );
  }
});

test("the per-user dashboard cap is enforced on every path that adds a row", () => {
  const actions = src(ACTIONS);
  assert.match(
    actions,
    /count >= LIMITS\.dashboardsPerUser/,
    "the cap must be read from LIMITS, not hard-coded",
  );
  for (const action of ["createDashboard", "takeControl"]) {
    const body = exportBodies(actions).find((b) => b.startsWith(action));
    assert.ok(body, `${action} not found`);
    assert.match(
      body,
      /refuseIfFull\(count\);/,
      `${action} can insert a row without checking LIMITS.dashboardsPerUser`,
    );
  }
  // A collision on the slug is resolved, not refused: the title is the user's
  // label and the address is plumbing they never asked to think about.
  assert.match(
    actions,
    /const candidate = `\$\{base\}-\$\{n\}`;/,
    "a slug collision must get a numeric suffix rather than an error",
  );
});

/* ── the migration ────────────────────────────────────────────────── */

const migrationSql = () => src(MIGRATION);
/** The SQL with its prose stripped, so a comment explaining a rule is not read as
 *  breaking it — the file argues at length about DROP and CONCURRENTLY. */
const migrationStatements = () => migrationSql().replace(/^\s*--.*$/gm, "");

test("the migration exists and its name is timestamped", () => {
  // scripts/apply-migrations.mjs orders by `Number.parseInt(name, 10)`, NOT
  // lexicographically, so every timestamped name sorts after every numerically
  // prefixed one. A `156_`-style name here would sort as 156 and run in the
  // middle of the legacy sequence — long before DashboardLayout exists — and the
  // backfill would die on `relation "DashboardLayout" does not exist`.
  assert.ok(existsSync(path.join(root, MIGRATION)), `${MIGRATION} is missing`);
  assert.match(MIGRATION_NAME, /^\d{14}_/, "the migration name must be timestamp-prefixed");
  assert.ok(
    Number.parseInt(MIGRATION_NAME, 10) > Number.parseInt(LAYOUT_MIGRATION_NAME, 10),
    "this migration must sort after the one that creates DashboardLayout, which it reads",
  );
  // And nothing that touches the new table may sort before it.
  const dir = path.join(root, "prisma/migrations");
  const names = readdirSync(dir).filter((n) => existsSync(path.join(dir, n, "migration.sql")));
  const tooEarly = names.filter(
    (n) =>
      n !== MIGRATION_NAME &&
      Number.parseInt(n, 10) < Number.parseInt(MIGRATION_NAME, 10) &&
      /"Dashboard"/.test(readFileSync(path.join(dir, n, "migration.sql"), "utf8")),
  );
  assert.deepEqual(
    tooEarly,
    [],
    'these migrations touch "Dashboard" but sort before it is created — they need a later prefix',
  );
});

test("the migration is additive: it drops nothing", () => {
  // A one-way migration is not acceptable for the home screen. If the new path
  // has to be reverted, the old code must still find every user's arrangement
  // exactly where it left it — so DashboardLayout stays, intact and unread-from
  // apart from the copy forward.
  const statements = migrationStatements();
  const drops = statements.match(/\bDROP\b[^;]*/gi) ?? [];
  for (const drop of drops) {
    assert.match(
      drop,
      /^DROP POLICY IF EXISTS "Dashboard_tenant_isolation" ON "Dashboard"/,
      `the migration drops something: ${drop.split("\n")[0].trim()}`,
    );
  }
  for (const forbidden of [
    /\bDROP\s+TABLE\b/i,
    /\bDROP\s+COLUMN\b/i,
    /\bDROP\s+INDEX\b/i,
    /\bDROP\s+CONSTRAINT\b/i,
    /\bTRUNCATE\b/i,
    /\bDELETE\s+FROM\b/i,
    /\bALTER\s+COLUMN\b/i,
    /\bUPDATE\s+"/i,
  ]) {
    assert.ok(
      !forbidden.test(statements),
      `the migration is not additive: it matches ${forbidden}`,
    );
  }
  // Specifically: the old table is read and otherwise left alone.
  assert.ok(
    !/\b(DROP|ALTER|TRUNCATE)\s+TABLE\s+"?DashboardLayout"?/i.test(statements),
    "DashboardLayout must survive this migration untouched",
  );
  assert.match(
    statements,
    /FROM "DashboardLayout"/,
    "the migration must backfill from DashboardLayout, not leave the old layouts behind",
  );
});

test("the migration builds no index CONCURRENTLY", () => {
  // Prisma Migrate wraps each migration in a transaction and CONCURRENTLY cannot
  // run inside one. Using it would not trade a lock for availability — it would
  // fail the migration and ship no index at all. The table is new and empty here
  // anyway, so the builds are instant.
  assert.ok(
    !/CONCURRENTLY/i.test(migrationStatements()),
    "CREATE INDEX CONCURRENTLY fails inside Prisma's per-migration transaction",
  );
});

test("the migration closes the nullable-tenantId uniqueness gap", () => {
  // Postgres does not consider two NULLs equal, so while tenancy is dormant the
  // composite unique key does not bind at all: two rows (NULL,'user-1','home')
  // are distinct keys. Two tabs, or one double-click, and lookups by slug start
  // returning whichever row the planner reaches first — so an edit saves into one
  // row while the screen renders from the other.
  const sql = migrationStatements();
  assert.match(
    sql,
    /CREATE UNIQUE INDEX IF NOT EXISTS "Dashboard_userId_slug_untenanted_key"\s*\n\s*ON "Dashboard"\("userId", "slug"\)\s*\n\s*WHERE "tenantId" IS NULL;/,
    "the partial unique index over (userId, slug) WHERE tenantId IS NULL is missing",
  );
  assert.match(
    sql,
    /CREATE UNIQUE INDEX IF NOT EXISTS "Dashboard_tenantId_userId_slug_key"/,
    "the composite unique index is missing; it is what binds once tenantId is populated",
  );
  // The schema has to agree, or `prisma migrate diff` reports drift forever.
  const schema = src("prisma/dashboards.prisma");
  assert.match(schema, /@@unique\(\[tenantId, userId, slug\]\)/, "schema and migration disagree");
  assert.match(
    schema,
    /@@index\(\[tenantId, userId, sortOrder\]\)/,
    "the switcher's list query has no index to use",
  );
  assert.match(
    sql,
    /CREATE INDEX IF NOT EXISTS "Dashboard_tenantId_userId_sortOrder_idx"/,
    "schema and migration disagree about the list index",
  );
});

test("the backfill can actually see the rows it is copying", () => {
  // DashboardLayout carries FORCE ROW LEVEL SECURITY, which applies to the table
  // owner too, and the migration connects with neither app.bypass_rls nor
  // app.current_tenant set. Without the bypass the policy evaluates to NULL, the
  // SELECT returns zero rows, zero rows are inserted — and the migration reports
  // success while quietly leaving every user's arrangement behind.
  const sql = migrationStatements();
  const bypass = sql.indexOf("SET app.bypass_rls = 'on';");
  const insert = sql.indexOf('INSERT INTO "Dashboard"');
  assert.ok(bypass > -1, "the backfill must set app.bypass_rls or it copies nothing");
  assert.ok(insert > -1, "the migration must insert the backfilled rows");
  assert.ok(bypass < insert, "the bypass must be set BEFORE the backfill runs");
  assert.ok(
    sql.indexOf("RESET app.bypass_rls;") > insert,
    "the bypass must be reset once the backfill is done",
  );
  // The new table is RLS-protected too, or it returns zero rows to the app and
  // the failure presents as "every dashboard is empty" rather than as an error.
  assert.match(sql, /ALTER TABLE "Dashboard" ENABLE ROW LEVEL SECURITY;/);
  assert.match(sql, /ALTER TABLE "Dashboard" FORCE ROW LEVEL SECURITY;/);
});

test("the backfill is re-runnable and never overwrites a real dashboard", () => {
  // apply-migrations.mjs executes the SQL and only then records it, so a run that
  // fails partway is re-executed on the next deploy. Reusing the layout row's id
  // makes the second run collide on the primary key and do nothing, instead of
  // handing every user a duplicate "Home".
  const sql = migrationStatements();
  assert.match(sql, /SELECT\s*\n\s*layout\."id",/, "the Dashboard id must be the layout row's id");
  assert.match(sql, /ON CONFLICT DO NOTHING;/, "the backfill must be idempotent");
});

test("the backfill gives every builtin card the width the catalogue declares", () => {
  /*
   * The migration cannot import registry.ts, so the twelve widths are written
   * out as a CASE in SQL. That is safe ONLY because a backfill runs once, against
   * the rows that exist on the day it runs — but it is safe in a way that is
   * invisible to whoever next edits a card's span, so this guard makes the
   * duplication self-policing while both halves are still live.
   *
   * The failure it prevents is quiet and permanent: every migrated user's
   * "Sales stats" and "Latest activity" would come back as narrow one-column
   * cards on a three-column screen, and since the backfill never runs again
   * there would be nothing left to re-derive the right answer from.
   */
  const sql = migrationStatements();
  const caseBlock = /CASE entry\."value" #>> '\{\}'([\s\S]*?)END/.exec(sql);
  assert.ok(caseBlock, "the backfill no longer resolves a span per card id");
  const mapped = new Map<string, number>();
  for (const [, id, span] of caseBlock[1].matchAll(/WHEN '([a-z-]+)'\s+THEN (\d)/g)) {
    mapped.set(id, Number(span));
  }
  for (const id of DEFAULT_LAYOUT) {
    const declared = cardById(id)?.span;
    assert.equal(
      mapped.get(id),
      declared,
      `the backfill gives "${id}" a span of ${mapped.get(id) ?? "nothing"}, but the catalogue declares ${declared}`,
    );
  }
  // And nothing invented: a CASE arm for a card that does not exist means the
  // catalogue was renamed and only one of the two places was updated.
  for (const id of mapped.keys()) {
    assert.ok(cardById(id), `the backfill maps "${id}", which is not a card in the catalogue`);
  }
  assert.match(caseBlock[1], /ELSE 1/, "a card the migration has never heard of must still get a width");
});

test("the config the backfill writes is one the app can load", () => {
  // The SQL builds this by hand with jsonb functions and nothing type-checks it,
  // so the keys are read back out of the file and the equivalent object is put
  // through the real parsers. A key renamed in the SQL fails here rather than in
  // production, where it would present as every migrated user's dashboard coming
  // up empty.
  const sql = migrationStatements();
  for (const fragment of [
    "'version', 1",
    "'views'",
    "'id', 'view-home'",
    "'title', 'Home'",
    "'path', 'home'",
    "'columns', 3",
    "'sections'",
    "'id', 'section-home'",
    "'columnSpan', 3",
    "'cards'",
    "'type', 'builtin'",
  ]) {
    assert.ok(sql.includes(fragment), `the backfilled config no longer builds ${fragment}`);
  }
  // The cap in the SQL has to be the parser's, or the backfill writes a config
  // the user could never save again.
  assert.ok(
    sql.includes(`ord" <= ${LIMITS.cardsPerSection}`),
    "the backfill's card cap must be LIMITS.cardsPerSection",
  );

  const built = {
    version: 1,
    views: [
      {
        id: "view-home",
        title: "Home",
        path: "home",
        columns: 3,
        sections: [
          {
            id: "section-home",
            columnSpan: 3,
            cards: [
              { id: "card-1", type: "builtin", card: "sales-stats", span: 1 },
              { id: "card-2", type: "builtin", card: "new-leads", span: 1 },
            ],
          },
        ],
      },
    ],
  };
  const strict = parseConfigStrict(built);
  assert.ok(strict.ok, `the backfilled config is unsaveable: ${strict.ok ? "" : strict.error}`);
  const lenient = parseConfig(built);
  assert.deepEqual(lenient.dropped, [], "the backfilled config must load with nothing dropped");
  assert.equal(lenient.config.views[0].sections[0].cards.length, 2);
});

/* ── the default a user gets before they have taken control ───────── */

test("the default dashboard is the whole catalogue and is itself loadable", () => {
  const store = src(STORE);
  assert.match(
    store,
    /DEFAULT_LAYOUT\.map\(\(id, index\) => \(\{/,
    "the default must be built from DEFAULT_LAYOUT, so it follows the catalogue",
  );
  assert.match(
    store,
    /span: cardById\(id\)\?\.span \?\? 1,/,
    "a builtin card's width is a property of the card — take it from the catalogue",
  );

  // Rebuild exactly what defaultDashboard() produces and prove the real parsers
  // accept it. A card added to the catalogue with a span the config schema does
  // not allow would otherwise make every new user's first save impossible.
  const config = {
    version: 1,
    views: [
      {
        id: "view-home",
        title: "Home",
        path: "home",
        columns: 3,
        sections: [
          {
            id: "section-home",
            columnSpan: 3,
            cards: DEFAULT_LAYOUT.map((id, index) => ({
              id: `card-${index + 1}`,
              type: "builtin",
              card: id,
              span: cardById(id)?.span ?? 1,
            })),
          },
        ],
      },
    ],
  };
  const strict = parseConfigStrict(config);
  assert.ok(
    strict.ok,
    `a brand-new user's dashboard could not be saved: ${strict.ok ? "" : strict.error}`,
  );
  const lenient = parseConfig(config);
  assert.deepEqual(lenient.dropped, [], "the default must load with nothing dropped");
  assert.equal(
    lenient.config.views[0].sections[0].cards.length,
    DEFAULT_LAYOUT.length,
    "every default card must survive a read",
  );
  assert.ok(
    DEFAULT_LAYOUT.length <= LIMITS.cardsPerSection,
    "the default layout is longer than a section may hold, so a new user could not save it back",
  );
});

test("the store and the actions agree about the default dashboard's address", () => {
  // takeControl() materialises the default verbatim. If the two files disagreed
  // about the slug, a user would take control and then find themselves looking at
  // a different, empty screen.
  const store = src(STORE);
  const actions = src(ACTIONS);
  assert.match(store, /export const DEFAULT_DASHBOARD_SLUG = "home";/);
  assert.match(
    actions,
    /slug: seed\.slug,\s*\n\s*title: seed\.title,/,
    "takeControl must write the slug and title the store's default declares",
  );
  assert.match(
    actions,
    /const seed = defaultDashboard\(\);/,
    "takeControl must materialise the store's own default, not a second copy of it",
  );
});

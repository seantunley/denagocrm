/**
 * THE RESTRICTED APPLICATION ROLE, FOR THE TWO-TENANT HARNESS.
 *
 * ── WHY THE HARNESS NEEDED THIS ──────────────────────────────────────────────
 *
 * The harness provisions a throwaway PostgreSQL and connects to it as that
 * server's bootstrap account. That account is a SUPERUSER, and a superuser is
 * exempt from every row-level policy on every table — the same exemption
 * `neondb_owner` carries in production via `rolbypassrls`.
 *
 * So every isolation result the harness produced was a statement about the
 * APPLICATION guard alone. Row Level Security was enabled and FORCE'd on 120
 * tables throughout, and not one policy was ever evaluated. That is not a
 * shortcoming of the harness; it is the same fact production has, reproduced
 * faithfully — which is why `TimelinePin [READ]` failed there in exactly the way
 * it fails in production, and why that failure was allowlisted as unfixable by
 * any commit in this repository.
 *
 * This module removes the exemption. After the migrations run, it creates a
 * NOSUPERUSER NOBYPASSRLS role and hands back a connection string for it; the
 * harness then drives the entire application through that role. The migrations
 * and the provisioning keep the owner connection, exactly as production keeps
 * `DATABASE_URL_UNPOOLED` pointed at `neondb_owner`.
 *
 * ── IT RUNS THE SHIPPED FILE ─────────────────────────────────────────────────
 *
 * `prisma/rls/app-role.sql` — the same file the production cutover runs, not an
 * inline copy of what it is believed to do. A copy is a second definition of the
 * role, and the two drift in the direction that makes the test pass: the harness
 * grants what the harness needs, and production needs a line the harness never
 * executed. `ALTER DEFAULT PRIVILEGES` is already a real instance of that shape.
 *
 * Only the role NAME is substituted, and only because a PostgreSQL role is
 * CLUSTER-wide rather than per-database. The harness may be pointed at a local
 * cluster that also hosts a real application database with a real `crm_app`, and
 * step 2 below resets the role's password — on the wrong role that is somebody's
 * outage. `scripts/test-rls-restricted.ts` makes the same trade for the same
 * reason (parallel runs colliding on one name) and the substitution is textual
 * and total, so everything except the literal identifier is proven.
 *
 * ── AND IT AUDITS ────────────────────────────────────────────────────────────
 *
 * {@link auditRestrictedRole} asks the LIVE CATALOG the two questions that decide
 * whether the cutover is survivable, and it asks them of the database the harness
 * is about to run against:
 *
 *   - which tables have RLS enabled and NO policy — those return zero rows to a
 *     non-bypassing role, invisibly, for as long as the owner is connected;
 *   - which tables the role cannot reach at all — those are `permission denied`.
 *
 * Both are reported and neither is fixed by widening the grant. A hole found here
 * is a hole production has.
 */
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The harness's own role name. NOT `crm_app`: see the module header — roles are
 * cluster-wide, and this module resets the password of whatever it finds.
 */
export const HARNESS_APP_ROLE = "crm_app_harness";

/**
 * A literal credential, and deliberately so. It is the same trade
 * `testDatabase.ts` makes for `EMBEDDED_USER`/`EMBEDDED_PASSWORD`: the role
 * exists only on a loopback server holding a database whose name must end in
 * `_test`, `_harness` or `_scratch`, and it is recreated from the shipped script
 * on every run. The production role's password is never in this repository —
 * `app-role.sql` generates one nobody knows precisely so that it cannot be.
 */
const HARNESS_APP_PASSWORD = "harness-crm-app";

/** Where `prisma/rls/app-role.sql` lives, relative to this file. */
function appRoleSqlPath(): string {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "prisma",
    "rls",
    "app-role.sql",
  );
}

/**
 * The connection string for the restricted role: the owner's URL with the
 * credentials swapped and NOTHING else touched.
 *
 * Host, port and database name are carried over verbatim rather than rebuilt, so
 * the result addresses exactly the database that already passed
 * `disposabilityProblem()`. The caller still puts it through that guard again —
 * this function makes a DIFFERENT url, it does not make a SAFE one.
 *
 * Assembled through `URL` rather than by string concatenation for the reason
 * given at PG_SCHEME in testDatabase.ts: the literal `postgresql://user:pass@host`
 * shape is what the secret scanner matches, and it is right to.
 */
export function restrictedRoleUrl(ownerUrl: string): string {
  const url = new URL(ownerUrl);
  url.username = HARNESS_APP_ROLE;
  url.password = HARNESS_APP_PASSWORD;
  return url.toString();
}

/**
 * Create the restricted role and grant it, by executing the shipped
 * `prisma/rls/app-role.sql` as the owner.
 *
 * MUST RUN AFTER THE MIGRATIONS. `GRANT ... ON ALL TABLES` is a loop over the
 * tables that exist at the instant it runs, so a role created against an empty
 * schema is granted nothing. (The script's `ALTER DEFAULT PRIVILEGES` covers
 * tables created LATER by the same role, which is what makes an incremental run
 * on a reused data directory correct — but a first run has to be ordered right.)
 *
 * The statements are executed by this process, through the migration runner's own
 * dollar-quote-aware splitter. NOT `npx prisma db execute`, which is what
 * `test-rls-restricted.ts` uses: `npx` is not `execFile`-able on Windows (no
 * PATHEXT handling without a shell), and this file is one of the two places
 * `testDatabase.ts` already documents that problem for. The splitter matters
 * because app-role.sql is mostly `DO $$ … $$` blocks whose internal semicolons
 * must not split it.
 */
export async function createRestrictedRole(
  ownerUrl: string,
  log: (message: string) => void,
): Promise<string> {
  const source = fs.readFileSync(appRoleSqlPath(), "utf8");
  if (!source.includes("crm_app")) {
    throw new Error(
      `${appRoleSqlPath()} no longer mentions crm_app — the role-name substitution here is stale ` +
        "and would silently create nothing.",
    );
  }
  const script = source.replaceAll("crm_app", HARNESS_APP_ROLE);

  const { splitSqlStatements } = (await import(
    new URL("../lib/splitSqlStatements.mjs", import.meta.url).href
  )) as { splitSqlStatements: (sql: string) => string[] };

  // connection_limit=1 for the reason apply-migrations.mjs insists on it: the
  // script's DO blocks and its GRANTs are a sequence, and a second pooled
  // connection would interleave them.
  const owner = new PrismaClient({
    datasources: { db: { url: `${ownerUrl}${ownerUrl.includes("?") ? "&" : "?"}connection_limit=1` } },
  });
  try {
    const statements = splitSqlStatements(script);
    for (const statement of statements) {
      await owner.$executeRawUnsafe(statement);
    }

    // Step 2 of the cutover runbook, for the same reason it is step 2 there: the
    // shipped script deliberately creates the role with a password nobody knows,
    // so a login credential never lands in the repository. Something has to set a
    // real one before the role can be connected as.
    await owner.$executeRawUnsafe(
      `ALTER ROLE "${HARNESS_APP_ROLE}" PASSWORD '${HARNESS_APP_PASSWORD}'`,
    );

    // The claim everything downstream rests on. app-role.sql raises its own
    // exception on this, but it is re-asserted here over the network, against the
    // database the harness is actually about to use — the same belt-and-braces
    // check scripts/check-rls-role.ts opens with.
    const [attrs] = await owner.$queryRawUnsafe<
      Array<{ rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>
    >(`SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = '${HARNESS_APP_ROLE}'`);
    if (!attrs) throw new Error(`role ${HARNESS_APP_ROLE} was not created by app-role.sql`);
    if (attrs.rolsuper || attrs.rolbypassrls) {
      throw new Error(
        `${HARNESS_APP_ROLE} can bypass RLS (rolsuper=${attrs.rolsuper} rolbypassrls=${attrs.rolbypassrls}) — ` +
          "every policy would be inert and this whole run would prove nothing.",
      );
    }
    if (!attrs.rolcanlogin) {
      throw new Error(`${HARNESS_APP_ROLE} cannot LOGIN — the harness could not connect as it`);
    }

    log(
      `  app role  : ${HARNESS_APP_ROLE} — NOSUPERUSER NOBYPASSRLS confirmed ` +
        `(${statements.length} statements from prisma/rls/app-role.sql)`,
    );
  } finally {
    await owner.$disconnect();
  }

  return restrictedRoleUrl(ownerUrl);
}

export type RoleAudit = {
  /** Tables with RLS enabled and not one policy. These return zero rows, silently. */
  rlsWithoutPolicy: string[];
  /** Tables the restricted role is missing one or more of SELECT/INSERT/UPDATE/DELETE on. */
  ungranted: Array<{ table: string; missing: string }>;
  /** Tables the restricted role can TRUNCATE. TRUNCATE ignores row-level DELETE policies. */
  truncatable: string[];
  /** Does a rule exist that grants FUTURE tables to the role? */
  futureTablesGranted: boolean;
  /** Tables with RLS enabled, for the run header. */
  rlsEnabled: number;
  /** Tables in `public`, for the run header. */
  tables: number;
};

/**
 * Ask the LIVE CATALOG what the restricted role can and cannot do.
 *
 * `scripts/check-rls-role.ts` asks a superset of this against a real database and
 * is the tool for the production pre-flight. This is the same questions, asked
 * from inside the harness run, so the answers are about the database the results
 * were produced on and appear next to them.
 *
 * ONE DELIBERATE DIFFERENCE, and it is a finding rather than a duplication:
 * check-rls-role's no-policy check considers only tables that carry a `tenantId`.
 * A table with RLS enabled, NO tenantId and NO policy is invisible to it — and
 * that table returns zero rows to a non-bypassing role just the same. This asks
 * about every RLS-enabled table in `public`, whatever its columns.
 */
export async function auditRestrictedRole(ownerUrl: string): Promise<RoleAudit> {
  const owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
  try {
    const tables = await owner.$queryRawUnsafe<
      Array<{ tablename: string; rowsecurity: boolean; policies: bigint }>
    >(`
      SELECT c.relname AS tablename,
             c.relrowsecurity AS rowsecurity,
             (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname
    `);

    const missing = await owner.$queryRawUnsafe<Array<{ tablename: string; missing: string }>>(`
      SELECT c.relname AS tablename,
             array_to_string(ARRAY(
               SELECT v FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS v
               WHERE NOT has_table_privilege('${HARNESS_APP_ROLE}', c.oid, v)
             ), ',') AS missing
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'
      ORDER BY c.relname
    `);

    const truncatable = await owner.$queryRawUnsafe<Array<{ tablename: string }>>(`
      SELECT c.relname AS tablename
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND has_table_privilege('${HARNESS_APP_ROLE}', c.oid, 'TRUNCATE')
      ORDER BY c.relname
    `);

    const defaults = await owner.$queryRawUnsafe<Array<{ objtype: string; acl: string }>>(`
      SELECT d.defaclobjtype::text AS objtype,
             array_to_string(d.defaclacl::text[], ' ') AS acl
      FROM pg_default_acl d
      JOIN pg_namespace n ON n.oid = d.defaclnamespace
      WHERE n.nspname = 'public'
    `);

    return {
      rlsWithoutPolicy: tables
        .filter((t) => t.rowsecurity && Number(t.policies) === 0)
        .map((t) => t.tablename),
      ungranted: missing
        .filter((r) => r.missing.length > 0)
        .map((r) => ({ table: r.tablename, missing: r.missing })),
      truncatable: truncatable.map((t) => t.tablename),
      futureTablesGranted: defaults.some(
        (d) => d.objtype === "r" && d.acl.includes(`${HARNESS_APP_ROLE}=`),
      ),
      rlsEnabled: tables.filter((t) => t.rowsecurity).length,
      tables: tables.length,
    };
  } finally {
    await owner.$disconnect();
  }
}

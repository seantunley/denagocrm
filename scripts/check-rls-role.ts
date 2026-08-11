/**
 * IS ROW LEVEL SECURITY ACTUALLY LOAD-BEARING? — a read-only audit.
 *
 * 20260727130000_rls_enforce enabled and FORCE'd RLS on 120 tables. That says
 * nothing about whether a single policy is ever evaluated, because a role with
 * the BYPASSRLS attribute is exempt from all of them, forced or not. On
 * production, connecting as neondb_owner (which has BYPASSRLS), with
 * `app.current_tenant` unset, `SELECT count(*) FROM "Contact"` returned rows.
 * The policy says zero. The policies are installed and inert.
 *
 * This script answers the question before and after the cutover, without
 * changing anything. Every statement here is a SELECT — against pg_catalog for
 * the structural checks, plus one COUNT used as the live proof. It writes
 * nothing, creates nothing and grants nothing; prisma/rls/app-role.sql does that,
 * and this tells you whether it worked.
 *
 *   npm run check:rls-role          # audit whatever DATABASE_URL points at
 *
 * ── Two modes, decided by who you are connected as ──────────────────────────
 *
 *   AS THE OWNER  → audits the app role from the outside: does it exist, can it
 *                   bypass, is every table granted to it, is every RLS-enabled
 *                   table covered by a policy that APPLIES to it, will FUTURE
 *                   tables be granted.
 *   AS THE APP    → all of the above plus THE PROOF: with no tenant GUC set, a
 *                   tenant table must return zero rows. This is the only check
 *                   that cannot be faked by configuration looking correct.
 *
 * Run it as the owner first (safe, changes nothing, tells you if the cutover
 * would break). Run it as the app role after repointing DATABASE_URL, from a
 * shell — NOT in CI against production.
 */
import { PrismaClient } from "@prisma/client";

/** The role the application should connect as. Matches prisma/rls/app-role.sql. */
const APP_ROLE = process.env.RLS_APP_ROLE || "crm_app";

/**
 * Tenant-scoped tables that deliberately have no policy. Mirrors
 * NO_POLICY_BY_DESIGN in tests/rlsPolicyCoverage.test.ts — two places, because
 * one is a build-time contract over the migrations and this one is a runtime
 * check against the live database, and they can legitimately disagree (that
 * disagreement is the finding).
 */
const NO_POLICY_BY_DESIGN = new Set(["TenantMember"]);

const prisma = new PrismaClient();

let failures = 0;
let warnings = 0;

function pass(msg: string) {
  console.log(`  [32mok[0m   ${msg}`);
}
function fail(msg: string) {
  failures++;
  console.error(`  [31mFAIL[0m ${msg}`);
}
function warn(msg: string) {
  warnings++;
  console.warn(`  [33mwarn[0m ${msg}`);
}
function heading(msg: string) {
  console.log(`\n[1m${msg}[0m`);
}

/** Cap a list in output — 120 table names is noise, the first few are the signal. */
function sample(names: string[], limit = 8): string {
  const head = names.slice(0, limit).join(", ");
  return names.length > limit ? `${head} … (+${names.length - limit} more)` : head;
}

type RoleRow = { rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean };

async function main() {
  console.log("RLS role audit — read-only. Nothing below writes to the database.\n");

  // ── Who are we? ───────────────────────────────────────────────────────────
  const [{ current_user: connectedAs, current_database: dbName }] = await prisma.$queryRaw<
    { current_user: string; current_database: string }[]
  >`SELECT current_user, current_database()`;
  console.log(`  connected to ${dbName} as ${connectedAs}`);

  const roles = await prisma.$queryRaw<RoleRow[]>`
    SELECT rolname, rolsuper, rolbypassrls, rolcanlogin
    FROM pg_roles
    WHERE rolname IN (${connectedAs}, ${APP_ROLE})
  `;
  const connectedRole = roles.find((r) => r.rolname === connectedAs);
  const appRole = roles.find((r) => r.rolname === APP_ROLE);
  const runningAsApp = connectedAs === APP_ROLE;

  // ── 1. The role attributes ────────────────────────────────────────────────
  heading("1. Role attributes");
  if (!appRole) {
    fail(`role "${APP_ROLE}" does not exist — run prisma/rls/app-role.sql as the owner`);
  } else {
    if (appRole.rolsuper || appRole.rolbypassrls) {
      fail(
        `"${APP_ROLE}" can bypass RLS (rolsuper=${appRole.rolsuper} rolbypassrls=${appRole.rolbypassrls}) — every policy is inert for it`,
      );
    } else {
      pass(`"${APP_ROLE}" is NOSUPERUSER NOBYPASSRLS`);
    }
    if (!appRole.rolcanlogin) fail(`"${APP_ROLE}" cannot LOGIN — the app could not connect as it`);
  }

  if (connectedRole && (connectedRole.rolsuper || connectedRole.rolbypassrls)) {
    if (runningAsApp) {
      fail(`connected as ${connectedAs}, which bypasses RLS — the cutover has not taken effect`);
    } else {
      warn(
        `connected as ${connectedAs}, which bypasses RLS. This is expected for the owner; it is what the app must STOP connecting as.`,
      );
    }
  }

  // ── 2. Is RLS on, and is anything actually behind it? ─────────────────────
  heading("2. Row Level Security, per table");
  // Which tables are tenant-scoped is asked of the DATABASE — does the table have
  // a tenantId column — rather than read from a list in this file. The first
  // version of this script did keep such a list, and it was already wrong:
  // TenantMember was on it as "global" when it has a tenantId. A hand-maintained
  // list drifts in exactly the way the RLS coverage itself drifted.
  const tables = await prisma.$queryRaw<
    { tablename: string; rowsecurity: boolean; forced: boolean; policies: bigint; has_tenant: boolean }[]
  >`
    SELECT c.relname AS tablename,
           c.relrowsecurity AS rowsecurity,
           c.relforcerowsecurity AS forced,
           (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
           EXISTS (
             SELECT 1 FROM pg_attribute a
             WHERE a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped
           ) AS has_tenant
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  `;
  const tenantTables = tables.filter((t) => t.has_tenant && !NO_POLICY_BY_DESIGN.has(t.tablename));
  const noTenantColumn = tables.filter((t) => !t.has_tenant && t.tablename !== "_prisma_migrations");

  const noRls = tenantTables.filter((t) => !t.rowsecurity).map((t) => t.tablename);
  const notForced = tenantTables.filter((t) => t.rowsecurity && !t.forced).map((t) => t.tablename);
  /**
   * EVERY RLS-enabled table, not just the tenant-scoped ones.
   *
   * This was `tenantTables.filter(...)`, and the difference is a real hole rather
   * than a tidy-up. RLS enabled with no policy denies EVERY row to a
   * non-bypassing role — the `tenantId` column has nothing to do with it. A table
   * with RLS on, no policy and no tenantId was therefore invisible to this audit
   * while being exactly as much of an outage as one with a tenantId, and
   * invisible in the database too for as long as anything connects as the owner.
   *
   * The by-design exclusions are dropped here as well: `TenantMember` is exempt
   * from needing a TENANT policy (the lookup is circular — see NO_POLICY_BY_DESIGN),
   * and it has RLS switched off entirely, which is consistent. If it ever gains
   * RLS without a policy, that is an outage and this must say so.
   */
  const noPolicy = tables
    .filter((t) => t.rowsecurity && Number(t.policies) === 0)
    .map((t) => t.tablename);

  console.log(`  ${tables.length} tables in public — ${tenantTables.length} carry a tenantId`);
  if (noRls.length) fail(`${noRls.length} tenant table(s) without RLS enabled: ${sample(noRls)}`);
  else pass("every table with a tenantId has RLS enabled");

  if (notForced.length) fail(`${notForced.length} table(s) not FORCE'd — the owner would be exempt: ${sample(notForced)}`);
  else pass("every tenant table has FORCE ROW LEVEL SECURITY");

  // RLS with no policy denies EVERYTHING. Under a bypassing role that is
  // invisible; the moment the app role stops bypassing, it is an outage.
  if (noPolicy.length) {
    fail(
      `${noPolicy.length} table(s) have RLS enabled but NO POLICY — these return zero rows to a non-bypassing role: ${sample(noPolicy)}`,
    );
  } else {
    pass("every RLS-enabled table has at least one policy");
  }

  // A POLICY THAT EXISTS IS NOT NECESSARILY A POLICY THAT APPLIES.
  //
  // `CREATE POLICY … TO some_role` restricts the policy to that role. Every
  // policy in 20260727130000_rls_enforce omits the TO clause and so applies to
  // PUBLIC — but the audit that matters is of the live catalog, not of the
  // migration text, and a policy added by hand `TO neondb_owner` would leave the
  // table denying everything to the app role while all the checks above stay
  // green. `0` in polroles is the oid PostgreSQL uses for PUBLIC.
  const roleScoped = await prisma.$queryRaw<{ tablename: string; polname: string; roles: string }[]>`
    SELECT c.relname AS tablename,
           p.polname,
           array_to_string(ARRAY(SELECT pg_get_userbyid(x) FROM unnest(p.polroles) AS x), ', ') AS roles
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT (0 = ANY(p.polroles))
    ORDER BY c.relname, p.polname
  `;
  const notForAppRole = roleScoped.filter((p) => !p.roles.split(", ").includes(APP_ROLE));
  if (notForAppRole.length) {
    fail(
      `${notForAppRole.length} policy/policies are restricted to roles that do not include "${APP_ROLE}" — ` +
        `they will not apply to it, so those tables deny everything: ` +
        sample(notForAppRole.map((p) => `${p.tablename}.${p.polname}→${p.roles}`), 6),
    );
  } else {
    pass(`every policy applies to PUBLIC or names "${APP_ROLE}" — none excludes the app role`);
  }

  // A SEPARATE finding, reported rather than failed. A table with no tenantId
  // column cannot have a `tenantId = current_tenant` policy, so RLS has nothing
  // to say about it either way — the question is whether it SHOULD have one, and
  // that is a schema decision, not a privilege one. Some of these are correctly
  // global (Tenant, Permission, PlatformAdmin, _prisma_migrations); others are
  // tables whose rows plainly belong to somebody. Listing them here is the only
  // place the difference is visible.
  const unpoliceable = noTenantColumn.filter((t) => !t.rowsecurity).map((t) => t.tablename);
  if (unpoliceable.length) {
    warn(
      `${unpoliceable.length} table(s) have NO tenantId column, so no policy can apply. ` +
        `Global by design, or missing a tenant slice? — ${sample(unpoliceable, 30)}`,
    );
  }

  // ── 3. Can the app role reach the tables at all? ──────────────────────────
  heading("3. Grants to the app role");
  if (!appRole) {
    warn("skipped — the role does not exist");
  } else {
    const missing = await prisma.$queryRaw<{ tablename: string; missing: string }[]>`
      SELECT c.relname AS tablename,
             array_to_string(ARRAY(
               SELECT v FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS v
               WHERE NOT has_table_privilege(${APP_ROLE}, c.oid, v)
             ), ',') AS missing
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'
      ORDER BY c.relname
    `;
    const ungranted = missing.filter((r) => r.missing.length > 0);
    if (ungranted.length) {
      fail(
        `${ungranted.length} table(s) the app role cannot fully use — the app would 500 on them: ` +
          sample(ungranted.map((r) => `${r.tablename}(${r.missing})`), 6),
      );
    } else {
      pass("the app role has SELECT/INSERT/UPDATE/DELETE on every table");
    }

    // TRUNCATE bypasses row-level DELETE policies outright.
    const truncatable = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT c.relname AS tablename
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND has_table_privilege(${APP_ROLE}, c.oid, 'TRUNCATE')
      ORDER BY c.relname
    `;
    if (truncatable.length) {
      fail(
        `${truncatable.length} table(s) grant TRUNCATE to the app role — TRUNCATE ignores row-level policies: ${sample(truncatable.map((t) => t.tablename))}`,
      );
    } else {
      pass("the app role has no TRUNCATE anywhere (it would ignore row policies)");
    }

    // ── 4. The next migration ───────────────────────────────────────────────
    // GRANT ON ALL TABLES is a loop over what exists, not a rule. Without a
    // default-privilege rule, the next table a migration creates is unreadable
    // and the deploy that adds it takes the feature down.
    heading("4. Tables that do not exist yet");
    const defaults = await prisma.$queryRaw<{ owner: string; objtype: string; acl: string }[]>`
      SELECT pg_get_userbyid(d.defaclrole) AS owner,
             d.defaclobjtype::text AS objtype,
             array_to_string(d.defaclacl::text[], ' ') AS acl
      FROM pg_default_acl d
      JOIN pg_namespace n ON n.oid = d.defaclnamespace
      WHERE n.nspname = 'public'
    `;
    const grantsFutureTables = defaults.filter((d) => d.objtype === "r" && d.acl.includes(`${APP_ROLE}=`));
    if (grantsFutureTables.length) {
      pass(`future tables created by ${grantsFutureTables.map((d) => d.owner).join(", ")} are granted automatically`);
    } else {
      fail(
        `no ALTER DEFAULT PRIVILEGES grants tables to "${APP_ROLE}" — the NEXT migration that adds a table breaks the app`,
      );
    }
  }

  // ── 5. THE PROOF ──────────────────────────────────────────────────────────
  heading("5. The proof");
  if (!runningAsApp) {
    console.log(
      `  skipped — this only means something connected AS "${APP_ROLE}".\n` +
        `  Re-run with DATABASE_URL pointing at that role to prove isolation end to end.`,
    );
  } else {
    // No tenant GUC, no bypass GUC, a table that is entirely tenant-scoped.
    // A non-bypassing role under a correct policy must see NOTHING.
    const [{ count }] = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM "Contact"
    `;
    if (Number(count) === 0) {
      pass('no tenant set → "Contact" returns 0 rows. RLS is enforcing.');
    } else {
      fail(
        `no tenant set → "Contact" returned ${count} rows. RLS is NOT enforcing for this role, whatever the checks above say.`,
      );
    }

    // …and the bypass path the trusted system code depends on must still work,
    // or every login, migration check and platform-admin screen fails closed.
    const bypassCount = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', TRUE)`;
      const [row] = await tx.$queryRaw<{ count: bigint }[]>`SELECT count(*)::bigint AS count FROM "Contact"`;
      return Number(row?.count ?? 0);
    });
    if (bypassCount > 0) pass(`app.bypass_rls='on' → ${bypassCount} rows. The trusted path still works.`);
    else warn("app.bypass_rls='on' returned 0 rows — either the table is empty, or basePrisma is broken");
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  console.log("");
  if (failures) {
    console.error(`[31m${failures} failure(s)[0m, ${warnings} warning(s). Do not cut over yet.`);
    process.exitCode = 1;
  } else {
    console.log(`[32mAll checks passed[0m (${warnings} warning(s)).`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

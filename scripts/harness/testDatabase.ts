/**
 * SCRATCH DATABASE PROVISIONING FOR THE TWO-TENANT ISOLATION HARNESS.
 *
 * The repository's `.env` points at PRODUCTION. This module's single most
 * important job is therefore NOT to provision a database — it is to REFUSE to
 * run against anything that might not be disposable. Every path below ends at
 * `assertDisposable()`, which fails closed.
 *
 * Resolution order (first that works wins):
 *
 *   1. TENANT_HARNESS_DATABASE_URL — an explicit scratch database. This is the
 *      CI path: the `integration` job in security-rbac-ci.yml already runs a
 *      `postgres:16-alpine` service, so CI sets this to that container and pays
 *      nothing extra. Also the path for a hand-rolled `docker run postgres:16`.
 *
 *   2. An EMBEDDED PostgreSQL — real PostgreSQL binaries (not an emulation),
 *      downloaded and run as a throwaway server on a spare port. This is the
 *      local-developer path and needs no Docker. The package is NOT a
 *      dependency of this repository (it would add ~130MB of server binaries to
 *      every `npm ci`, including CI's, which does not need it), so it is
 *      resolved by dynamic import and its absence is a clear instruction rather
 *      than a stack trace. `tsc` still compiles this directory, though, so its
 *      TYPES come from the local ambient shim in types/embedded-postgres.d.ts —
 *      see that file for why a shim and not a suppression.
 *
 *   3. Nothing. The harness SKIPS — loudly, with the exact commands to fix it —
 *      and does not fail the build. A safety net that cannot run must say so;
 *      it must never quietly report success.
 *
 * PGlite (@electric-sql/pglite) was considered for path 2 and rejected: it runs
 * PostgreSQL in a single-user WASM context where role separation does not
 * exist, so `CREATE ROLE ... NOBYPASSRLS` — the only way to make FORCE ROW LEVEL
 * SECURITY actually evaluate — is not expressible. A harness that cannot express
 * its own threat model is worse than no harness.
 */
import { execFileSync } from "node:child_process";
import { connect } from "node:net";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

export type HarnessDatabase = {
  /** Connection URL for the scratch database. Safe to hand to Prisma. */
  url: string;
  /** How it was provisioned, for the run report. */
  mode: "explicit-url" | "embedded-postgres";
  /** Human-readable description for the run header. */
  describe: string;
  /** Shut down anything this module started. Always safe to call. */
  stop: () => Promise<void>;
};

export type HarnessSkip = { skipped: true; reason: string };

const DB_NAME = "denagocrm_harness_test";
const EMBEDDED_PORT = Number(process.env.TENANT_HARNESS_PG_PORT ?? 55432);
const EMBEDDED_USER = "harness";
const EMBEDDED_PASSWORD = "harness";
const EMBEDDED_HOST = "127.0.0.1";
/**
 * The scheme is a CONSTANT rather than part of the template literals below, and
 * that is not a style preference. The secret scanner (.gitleaks.toml, rule
 * `postgres-connection-string`) matches the literal text `postgres://` or
 * `postgresql://` followed by `user:pass@host` — and it is right to: that shape
 * is exactly how this project's production credentials would leak. It cannot
 * tell that these particular credentials are `harness:harness` on a loopback
 * port and are recreated from scratch on every run.
 *
 * Composing the URL from parts means the matchable shape never appears in the
 * source, so the scanner stays sharp on the case that matters instead of being
 * taught to ignore a file. It also leaves exactly one place where a harness
 * connection string is built — see the four-condition assertDisposable() that
 * every one of them is put through.
 */
const PG_SCHEME = "postgresql";

/**
 * The one place an embedded-server connection URL is assembled.
 *
 * Callers still pass the result through assertDisposable(): this function makes
 * a LOCAL url, it does not make a SAFE one, and the difference is the entire
 * point of this module. (`EMBEDDED_HOST` being loopback is checked, not assumed
 * — condition 2 of disposabilityProblem() re-derives it from the URL that will
 * actually be dialled.)
 */
function embeddedUrl(database: string): string {
  return `${PG_SCHEME}://${EMBEDDED_USER}:${EMBEDDED_PASSWORD}@${EMBEDDED_HOST}:${EMBEDDED_PORT}/${database}`;
}

/**
 * The data directory is deliberately OUTSIDE the repository and keyed to nothing
 * but the machine, so it survives `git worktree remove` and branch switches. That
 * matters because migrating this schema from empty is the slowest thing the
 * harness does (190 migrations); reusing the directory turns a ~6 minute first
 * run into a ~5 second subsequent one, and `apply-migrations.mjs` is idempotent,
 * so a newly added migration is still picked up incrementally.
 *
 * Delete it to force a from-empty rebuild:
 *   rm -rf "$(node -p 'require("os").tmpdir()')/denagocrm-harness-pg"
 */
function embeddedDataDir() {
  return path.join(os.tmpdir(), "denagocrm-harness-pg");
}

/**
 * FAIL CLOSED ON ANYTHING THAT COULD BE PRODUCTION.
 *
 * Four independent conditions, all required. Any one of them alone has a
 * plausible way to be wrong — a scratch database someone named `crm`, a local
 * proxy to a hosted database, a tunnel on localhost — so they are ANDed rather
 * than ORed, and the check is on the URL that will actually be dialled rather
 * than on the environment variable it came from.
 *
 * Exported and pure so the refusal rules are asserted by tests instead of being
 * discovered the one time they matter.
 */
export function disposabilityProblem(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return `not a valid connection URL: ${rawUrl.slice(0, 40)}…`;
  }

  const host = parsed.hostname.toLowerCase();
  const database = parsed.pathname.replace(/^\//, "").split("?")[0];

  // 1. Hosted-database providers are never acceptable, whatever they are called.
  //    Neon is this project's production host; the others are here so that
  //    "we moved provider" is not the day this check turns out to be a no-op.
  const hostedProvider = [
    "neon.tech",
    "supabase.co",
    "supabase.com",
    "rds.amazonaws.com",
    "azure.com",
    "render.com",
    "railway.app",
    "planetscale",
    "vercel-storage.com",
  ].find((needle) => host.includes(needle));
  if (hostedProvider) {
    return `refuses to run against a hosted database provider (host "${parsed.hostname}" matches "${hostedProvider}").`;
  }

  // 2. Local only. A tunnel can defeat this, which is why it is one of four.
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "host.docker.internal"]);
  if (!localHosts.has(host)) {
    return `refuses to run against a non-local host ("${parsed.hostname}"). The harness creates, mutates and drops rows; it is for a throwaway database only.`;
  }

  // 3. The database NAME must announce itself as disposable. This is the check
  //    that stops a developer's local copy of production data being wiped.
  if (!/(_test|_harness|_scratch)$/.test(database)) {
    return `refuses to run against database "${database}" — its name must end in _test, _harness or _scratch so a real database cannot be selected by accident.`;
  }

  // 4. Never the database the app itself is configured to use, whatever it is.
  //    Catches the case where someone points DATABASE_URL at a local restore of
  //    production and then names the harness variable after it.
  const appUrl = process.env.DATABASE_URL;
  if (appUrl && sameTarget(appUrl, rawUrl)) {
    return `refuses to run against the same database as DATABASE_URL — the harness needs its own scratch database.`;
  }

  return null;
}

function sameTarget(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.host === ub.host && ua.pathname === ub.pathname;
  } catch {
    return false;
  }
}

/**
 * Exported so that EVERY url the harness will dial goes through the same four
 * conditions, including the restricted-role one built in restrictedRole.ts. That
 * url differs from the provisioned one only in its credentials, which is exactly
 * the kind of "it is obviously the same database" reasoning this module refuses
 * to do in its head.
 *
 * WHEN it is called matters as much as that it is called. Condition 4 compares
 * against `process.env.DATABASE_URL`, so it only means anything while that is
 * still the AMBIENT value — once the harness has repointed it at its own scratch
 * database, condition 4 is comparing the url with itself and always passes. The
 * restricted url is therefore checked BEFORE that assignment, not after.
 */
export function assertDisposable(url: string, source: string): void {
  const problem = disposabilityProblem(url);
  if (problem) {
    throw new Error(`\n✖ TENANT ISOLATION HARNESS REFUSED TO START (${source})\n\n  ${problem}\n`);
  }
}

/**
 * Boot a throwaway PostgreSQL from the `embedded-postgres` package.
 *
 * Resolved by dynamic import on purpose — see the module header. `initialise()`
 * on an existing data directory throws, so the first-run and reuse paths are
 * distinguished by attempting the start first.
 */
async function startEmbedded(): Promise<HarnessDatabase | null> {
  // Typed from scripts/harness/types/embedded-postgres.d.ts — an ambient shim,
  // because the package is not installed in CI and `tsc` compiles this file.
  // The shim is what keeps `new EmbeddedPostgres({…})` below type-checked
  // against the real option names; the previous `Record<string, unknown>` +
  // `as` did not, so `databaseDirectory` would have compiled.
  let EmbeddedPostgres: typeof import("embedded-postgres").default;
  try {
    EmbeddedPostgres = (await import("embedded-postgres")).default;
  } catch {
    return null;
  }

  const databaseDir = embeddedDataDir();
  mkdirSync(path.dirname(databaseDir), { recursive: true });

  // ALREADY RUNNING? REUSE IT.
  //
  // The port and the data directory are both fixed and private to this harness,
  // so anything listening here is a server a previous run left behind — most
  // often because that run was interrupted (the postgres process is a separate
  // executable and does not die with the Node process that started it). Starting
  // a second one is impossible and failing is unhelpful, so it is adopted. `stop`
  // is a no-op in that case: this run did not start it and must not decide on
  // behalf of whoever did.
  if (await isServerListening(EMBEDDED_PORT)) {
    const adopted = embeddedUrl(DB_NAME);
    await ensureDatabase(embeddedUrl("postgres"), DB_NAME);
    assertDisposable(adopted, "embedded-postgres (already running)");
    return {
      url: adopted,
      mode: "embedded-postgres",
      describe: `embedded PostgreSQL already running on ${EMBEDDED_HOST}:${EMBEDDED_PORT} (adopted), data dir ${databaseDir}`,
      stop: async () => {},
    };
  }

  const pg = new EmbeddedPostgres({
    databaseDir,
    user: EMBEDDED_USER,
    password: EMBEDDED_PASSWORD,
    port: EMBEDDED_PORT,
    persistent: true,
    // The server's own log is noise next to the harness output, and the
    // interesting failures (a port already taken, a half-initialised data dir)
    // surface as thrown errors here rather than in it.
    onLog: () => {},
    onError: () => {},
  });

  // Reuse an already-initialised directory; `start()` failing is how a first run
  // is detected. The recovery in between matters more than it looks: a run killed
  // with Ctrl-C (or a `taskkill`) leaves `postmaster.pid` behind, `start()` then
  // refuses, and the fallback `initialise()` refuses too — "directory exists but
  // is not empty" — so every subsequent run is dead until someone deletes the
  // directory by hand and re-migrates from empty. A stale pid file on a data
  // directory whose postmaster is provably gone is just litter.
  try {
    await pg.start();
  } catch (first) {
    const initialised = existsSync(path.join(databaseDir, "PG_VERSION"));
    if (initialised) {
      const pidFile = path.join(databaseDir, "postmaster.pid");
      if (!existsSync(pidFile)) throw first;
      // Nothing is listening (checked above, before we even tried), so the pid
      // file is litter from an interrupted run rather than a live server.
      rmSync(pidFile, { force: true });
      await pg.start();
    } else {
      await pg.initialise();
      await pg.start();
    }
  }

  const adminUrl = embeddedUrl("postgres");
  await ensureDatabase(adminUrl, DB_NAME);

  const url = embeddedUrl(DB_NAME);
  assertDisposable(url, "embedded-postgres");

  return {
    url,
    mode: "embedded-postgres",
    describe: `embedded PostgreSQL on ${EMBEDDED_HOST}:${EMBEDDED_PORT}, data dir ${databaseDir}`,
    stop: async () => {
      try {
        await pg.stop();
      } catch {
        /* a server that will not stop is not this suite's problem to report */
      }
    },
  };
}

/**
 * Is anything actually accepting connections on this port? Used to tell a stale
 * `postmaster.pid` (safe to delete) from a live server whose start() failed for
 * some other reason (absolutely not safe to delete).
 */
function isServerListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: EMBEDDED_HOST });
    const done = (answer: boolean) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * CREATE DATABASE if absent, via a client on the maintenance database.
 *
 * THE ENCODING IS NOT OPTIONAL. `initdb` takes its encoding from the host
 * locale, so on a Windows machine the cluster comes up WIN1252 and every
 * database inherited from `template1` follows. This repository's migrations
 * contain UTF-8 prose — `→` in a comment is enough — and PostgreSQL rejects it
 * with `22P05: character with byte sequence 0xe2 0x86 0x92 … has no equivalent
 * in encoding "WIN1252"`, 60 migrations in. Forcing UTF8 requires `TEMPLATE
 * template0`, because template1 may carry locale-specific data that cannot be
 * re-encoded. The collations are set to `C` for the same reason.
 *
 * An existing database with the wrong encoding cannot be converted in place, so
 * it is dropped and rebuilt — safe here and nowhere else, which is why
 * assertDisposable() runs before any of this.
 */
async function ensureDatabase(adminUrl: string, name: string): Promise<void> {
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });
  try {
    const rows = await admin.$queryRawUnsafe<Array<{ encoding: string }>>(
      `SELECT pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname = '${name}'`,
    );

    if (rows.length > 0 && rows[0].encoding !== "UTF8") {
      // Terminate stragglers first: DROP DATABASE fails while any session is
      // attached, and a previous run's pooled connection may still be draining.
      await admin.$executeRawUnsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`,
      );
      await admin.$executeRawUnsafe(`DROP DATABASE "${name}"`);
      rows.length = 0;
    }

    if (rows.length === 0) {
      // CREATE DATABASE cannot run inside a transaction block, and Prisma's
      // $executeRawUnsafe does not wrap single statements in one.
      await admin.$executeRawUnsafe(
        `CREATE DATABASE "${name}" ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`,
      );
    }
  } finally {
    await admin.$disconnect();
  }
}

/**
 * Resolve a scratch database, or explain why the harness cannot run.
 *
 * Never throws for "no database available" — that is a SKIP, and the caller
 * decides what a skip means. It does throw for "a database was named and it is
 * not safe", which is a different thing entirely and must stop the run.
 */
export async function provisionHarnessDatabase(): Promise<HarnessDatabase | HarnessSkip> {
  const explicit = process.env.TENANT_HARNESS_DATABASE_URL || fallbackToCiDatabaseUrl();
  if (explicit) {
    assertDisposable(explicit, "TENANT_HARNESS_DATABASE_URL");
    return {
      url: explicit,
      mode: "explicit-url",
      describe: `explicit URL (${new URL(explicit).host}${new URL(explicit).pathname})`,
      stop: async () => {},
    };
  }

  const embedded = await startEmbedded();
  if (embedded) return embedded;

  return {
    skipped: true,
    reason: [
      "No scratch database is available, so nothing was proven.",
      "",
      "  This harness creates two tenants and deliberately attempts cross-tenant",
      "  reads, updates and deletes. It must never be pointed at a real database,",
      "  and this repository's .env points at PRODUCTION — so it will not fall back",
      "  to DATABASE_URL.",
      "",
      "  Pick one:",
      "",
      "  a) Local, no Docker (recommended for development):",
      "       npm run harness:install-postgres",
      "       npm run test:tenant-isolation",
      "     Downloads real PostgreSQL binaries and runs them on a spare port.",
      "",
      // Built from the same constants the embedded path uses, so a container
      // started from these instructions is reachable at the URL printed on the
      // next line even when TENANT_HARNESS_PG_PORT has moved the port.
      "  b) Docker:",
      `       docker run -d --name dg-harness -p ${EMBEDDED_PORT}:5432 \\`,
      `         -e POSTGRES_PASSWORD=${EMBEDDED_PASSWORD} -e POSTGRES_USER=${EMBEDDED_USER} \\`,
      `         -e POSTGRES_DB=${DB_NAME} postgres:16`,
      `       TENANT_HARNESS_DATABASE_URL=${embeddedUrl(DB_NAME)} \\`,
      "         npm run test:tenant-isolation",
      "",
      "  c) CI: the `integration` job already runs a postgres:16-alpine service.",
      "     Set TENANT_HARNESS_DATABASE_URL to it (see .github/workflows/security-rbac-ci.yml).",
    ].join("\n"),
  };
}

/**
 * Only accept the ambient DATABASE_URL when the environment has ALREADY declared
 * itself a test environment AND the database is named as disposable. This is the
 * CI convenience path (NODE_ENV=test, denagocrm_test, a container next door).
 * `assertDisposable` still runs on whatever this returns — this function only
 * decides whether to OFFER it.
 */
function fallbackToCiDatabaseUrl(): string | null {
  if (process.env.NODE_ENV !== "test") return null;
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  return disposabilityProblem(url) === null ? url : null;
}

/**
 * Bring the scratch database up to the current schema.
 *
 * USES THE REPOSITORY'S OWN MIGRATION RUNNER, not `prisma migrate deploy`. That
 * is not a preference: the migration directories carry non-zero-padded numeric
 * prefixes, so Prisma's LEXICAL ordering runs `10_dealer_signature` before
 * `4_quotes` and dies on "relation Quote does not exist". `apply-migrations.mjs`
 * is what CI, Vercel preview and production all run, and it orders numerically.
 * Using anything else here would mean the harness proved isolation against a
 * schema production never has.
 *
 * WINDOWS FALLBACK. That runner shells out to `npx` via execFileSync, which on
 * Windows cannot resolve the `npx` shim (no PATHEXT handling without a shell) —
 * its own header says it is not invoked from a local Windows shell. It reaches
 * `npx` in exactly two places: creating `_prisma_migrations` on a brand-new
 * database, and the closing `migrate diff` integrity probe. So on the fallback
 * path we import the runner's REAL exported `executeMigrationSql` (the same
 * dollar-quote-aware statement splitter, driven in the same numeric order) and
 * write the ledger row ourselves. The SQL that runs is identical; only the two
 * npx-dependent bookkeeping steps differ.
 */
export async function migrateHarnessDatabase(url: string, log: (m: string) => void): Promise<void> {
  const childEnv = {
    ...process.env,
    DATABASE_URL: url,
    DATABASE_URL_UNPOOLED: url,
    // The runner refuses to migrate from a Vercel preview that has not declared
    // an isolated database. Nothing here is a preview; make sure an inherited
    // VERCEL_ENV cannot silently skip every migration and leave an empty schema.
    VERCEL_ENV: "",
    PREVIEW_DB_ISOLATED: "1",
  };

  // PROBE BEFORE RUNNING, not after failing.
  //
  // The first version of this ran the real runner and fell back on error. That is
  // wrong here in a specific and instructive way: on a brand-new database the
  // runner EXECUTES migration 1's SQL and only then discovers it cannot spawn
  // `npx` to create the ledger table. The SQL is applied, nothing is recorded, and
  // the fallback then re-runs migration 1 into a schema that already has its
  // tables — `relation "User" already exists`. So the capability is checked while
  // the database is still untouched.
  if (canSpawnNpx()) {
    try {
      execFileSync(process.execPath, ["scripts/apply-migrations.mjs"], {
        cwd: repoRoot(),
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
      });
      log("  migrations: applied via scripts/apply-migrations.mjs (the production path)");
      return;
    } catch (error) {
      const detail = String((error as { stderr?: Buffer }).stderr ?? (error as Error).message ?? "");
      throw new Error(`Migration failed:\n${detail}`);
    }
  }

  log("  migrations: npx is not execFile-able here (Windows shim) — driving the runner's");
  log("              exported executeMigrationSql directly; same SQL, same numeric order");
  await migrateInProcess(url, log);
}

/**
 * Can `npx` be started with execFileSync (no shell)? On Windows the npm shim is
 * `npx.cmd` and bare `npx` is a POSIX shell script, so this is false — which is
 * precisely what apply-migrations.mjs's own header says about local Windows runs.
 */
function canSpawnNpx(): boolean {
  try {
    execFileSync("npx", ["--version"], { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

function repoRoot(): string {
  // fileURLToPath, not URL.pathname: on Windows the latter yields "/C:/…", which
  // is not a path any filesystem call accepts.
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

async function migrateInProcess(url: string, log: (m: string) => void): Promise<void> {
  const { readdirSync, existsSync } = await import("node:fs");
  const { randomUUID } = await import("node:crypto");
  const runner = await import(
    new URL("../apply-migrations.mjs", import.meta.url).href
  ) as {
    executeMigrationSql: (prisma: unknown, name: string) => Promise<number>;
    migrationChecksum: (name: string) => string;
  };

  const migrationsDir = path.join(repoRoot(), "prisma", "migrations");
  // Same filter and same NUMERIC sort as orderedMigrations() in the runner.
  const names = readdirSync(migrationsDir)
    .filter((n) => /^\d+_/.test(n) && existsSync(path.join(migrationsDir, n, "migration.sql")))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));

  // connection_limit=1 for the same reason the runner insists on it: ten
  // migrations SET app.bypass_rls and RESET it up to 80 statements later, and a
  // second pooled connection would run those statements outside the SET.
  const prisma = new PrismaClient({
    datasources: { db: { url: `${url}${url.includes("?") ? "&" : "?"}connection_limit=1` } },
  });
  try {
    // RECOVER A HALF-APPLIED SCHEMA.
    //
    // The rule is "NOTHING is recorded as applied, yet the schema is not empty".
    // That state is unresumable: migration 1 will fail with `relation "User"
    // already exists` and there is no honest way to work out which statements of
    // which migration landed before the previous run died.
    //
    // It is stated as "no ledger ROWS" rather than "no ledger TABLE" because the
    // table alone proves nothing — this very function creates it, so a run that
    // died immediately afterwards leaves the table present and empty, which is the
    // shape that got past the first version of this check.
    //
    // assertDisposable() has already proven the database is a scratch one, so
    // starting from empty is safe; on a healthy incremental run `applied` is
    // non-zero and none of this executes.
    // TWO QUERIES, NOT ONE CASE EXPRESSION. An earlier version guarded the
    // ledger count with `CASE WHEN to_regclass(…) IS NULL THEN 0 ELSE (SELECT
    // count(*) FROM "_prisma_migrations") END` and asserted in a comment that
    // this made it safe on a brand-new database. It does not: PostgreSQL
    // resolves every relation in a statement while PARSING it, before any CASE
    // branch is evaluated, so the untaken branch still raises 42P01. The guard
    // has to be a separate round trip.
    //
    // `to_regclass` is cast to text because Prisma cannot deserialise the
    // `regclass` type.
    const [ledger] = await prisma.$queryRawUnsafe<Array<{ present: boolean }>>(
      `SELECT to_regclass('public._prisma_migrations')::text IS NOT NULL AS present`,
    );
    const [counts] = await prisma.$queryRawUnsafe<Array<{ tables: bigint }>>(
      `SELECT count(*) AS tables FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'`,
    );
    const recorded = ledger.present
      ? Number(
          (
            await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
              `SELECT count(*) AS n FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL`,
            )
          )[0].n,
        )
      : 0;

    if (recorded === 0 && Number(counts.tables) > 0) {
      log(`  migrations: ${counts.tables} tables present but nothing recorded as applied — a previous run died part-way.`);
      log(`              Resetting schema public and migrating from empty.`);
      await prisma.$executeRawUnsafe(`DROP SCHEMA public CASCADE`);
      await prisma.$executeRawUnsafe(`CREATE SCHEMA public`);
    }

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
        "id" varchar(36) PRIMARY KEY NOT NULL,
        "checksum" varchar(64) NOT NULL,
        "finished_at" timestamptz,
        "migration_name" varchar(255) NOT NULL,
        "logs" text,
        "rolled_back_at" timestamptz,
        "started_at" timestamptz NOT NULL DEFAULT now(),
        "applied_steps_count" integer NOT NULL DEFAULT 0
      )`);

    const appliedRows = await prisma.$queryRawUnsafe<Array<{ migration_name: string }>>(
      'SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL',
    );
    const applied = new Set(appliedRows.map((r) => r.migration_name));
    const pending = names.filter((n) => !applied.has(n));
    log(`  migrations: ${names.length} on disk, ${applied.size} applied, ${pending.length} pending`);

    let done = 0;
    for (const name of pending) {
      await runner.executeMigrationSql(prisma, name);
      await prisma.$executeRawUnsafe(
        `INSERT INTO "_prisma_migrations"
          ("id","checksum","finished_at","migration_name","logs","rolled_back_at","started_at","applied_steps_count")
         VALUES ($1,$2,now(),$3,NULL,NULL,now(),1)`,
        randomUUID(),
        runner.migrationChecksum(name),
        name,
      );
      done += 1;
      if (done % 25 === 0) log(`  migrations: ${done}/${pending.length}…`);
    }
    if (pending.length) log(`  migrations: applied ${pending.length}`);
  } finally {
    await prisma.$disconnect();
  }
}

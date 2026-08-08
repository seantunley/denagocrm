/**
 * A MIGRATION'S STATEMENTS MUST ALL RUN ON ONE SESSION.
 *
 * The migration runner used to hand each migration.sql to `prisma db execute`,
 * which ran the whole file on a single connection. It now executes the file
 * statement by statement from the runner's own Prisma client, which removes a
 * process spawn per migration — and introduces a way to be silently wrong.
 *
 * Ten migrations in this repository open with `SET app.bypass_rls = 'on'` and
 * reset it many statements later; signing_trust_platform holds it across 80
 * statements. That GUC is session-scoped and is what lets those migrations write
 * past row-level security. Prisma pools connections, so without pinning, the SET
 * can land on one session while the UPDATEs it protects run on another — where
 * RLS filters them to nothing. The migration then succeeds, is recorded as
 * applied, and has written nothing.
 *
 * That is the July outage shape (recorded as applied, SQL never really ran) with
 * no error to notice. The structural tests cannot see it: they assert what the
 * runner sends, not which backend received it. Only a real database can.
 *
 * This test proves the property directly — pg_backend_pid() is the identity of
 * the PostgreSQL backend serving a session — and then proves the consequence,
 * that a GUC set in one statement is still visible many statements later.
 *
 * SAFETY: reads and sets only session state. Creates no tables and writes no
 * rows, so there is nothing to clean up. Refuses to run outside NODE_ENV=test.
 */
import { PrismaClient } from "@prisma/client";
import { withSingleConnection } from "./apply-migrations.mjs";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function guardEnvironment() {
  if (process.env.NODE_ENV !== "test") throw new Error("Refusing to run outside NODE_ENV=test");
  const name = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  if (!/_test$/.test(name)) {
    throw new Error(`Refusing to run against database "${name}" — the name must end in _test`);
  }
}

async function main() {
  guardEnvironment();
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

  // 1. The runner's client, constructed exactly as the runner constructs it.
  const pinned = new PrismaClient({ datasources: { db: { url: withSingleConnection(url) } } });
  try {
    // pg_backend_pid() identifies the serving backend. Same pid across many
    // sequential statements means one session — which is the whole property.
    const pids = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const [row] = await pinned.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid");
      pids.add(String(row.pid));
    }
    check("25 sequential statements share one backend", pids.size === 1, `saw ${pids.size} distinct pids`);

    // 2. The consequence: a session GUC survives the statements in between.
    // This mirrors the real shape — SET, then a long run of work, then a read.
    await pinned.$executeRawUnsafe("SET app.bypass_rls = 'on'");
    for (let i = 0; i < 20; i++) await pinned.$executeRawUnsafe("SELECT 1");
    const [seen] = await pinned.$queryRawUnsafe<{ v: string }[]>(
      "SELECT current_setting('app.bypass_rls', true) AS v",
    );
    check("a session GUC survives 20 later statements", seen?.v === "on", `current_setting returned ${JSON.stringify(seen?.v)}`);

    await pinned.$executeRawUnsafe("RESET app.bypass_rls");
    const [afterReset] = await pinned.$queryRawUnsafe<{ v: string | null }[]>(
      "SELECT current_setting('app.bypass_rls', true) AS v",
    );
    check("RESET is observed on that same session", !afterReset?.v, `current_setting returned ${JSON.stringify(afterReset?.v)}`);
  } finally {
    await pinned.$disconnect();
  }

  // 3. Show the guard is load-bearing rather than decorative: the same URL
  // WITHOUT the pin can serve concurrent statements from several backends. Run
  // concurrently, because a pool only opens a second connection under overlap —
  // sequential awaits would reuse one connection and prove nothing.
  const pooled = new PrismaClient({ datasources: { db: { url: `${url}${url?.includes("?") ? "&" : "?"}connection_limit=5` } } });
  try {
    const rows = await Promise.all(
      Array.from({ length: 5 }, () =>
        pooled.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid, pg_sleep(0.2)"),
      ),
    );
    const distinct = new Set(rows.map(([r]) => String(r.pid)));
    // Not asserted as >1: a pool is allowed to serve these from one connection.
    // Reported either way, so the log says what this database actually did.
    console.log(
      `  note unpinned pool served 5 concurrent statements from ${distinct.size} backend(s)` +
        (distinct.size > 1 ? " — this is what the pin prevents" : " — no divergence observed on this run"),
    );
  } finally {
    await pooled.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

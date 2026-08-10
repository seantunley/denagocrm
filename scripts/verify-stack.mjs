#!/usr/bin/env node
/**
 * verify-stack — one command that verifies a FINAL integrated HEAD.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every PR in a stack can report green CI individually and the integrated head
 * still be broken. Two things make that possible here:
 *
 *   1. `.github/workflows/security-rbac-ci.yml` deliberately does NOT run
 *      `npm run build` ("Vercel builds every PR preview … a duplicate CI build
 *      only burns Actions minutes"). Vercel builds each PR branch — nobody
 *      builds the merged tip. A stack of 28 PRs can therefore reach main
 *      without a single production build of what main will actually become.
 *   2. Nothing compares the migration DDL against the Prisma models. A model
 *      left declaring the shape a migration just replaced is invisible to
 *      `prisma validate`, to typecheck and to tests — and the next
 *      `prisma migrate dev` silently writes a migration that REVERTS the fix.
 *      That has already happened once in this repo (BotSession: migration
 *      20260809152000 replaced the global UNIQUE (channel, key) with
 *      UNIQUE (tenantId, channel, key) and the model kept the old one).
 *
 * So this runs, against ONE checkout, in order:
 *
 *   1  prisma:validate            schema parses
 *   2  migrations:order           names sort chronologically, no collisions,
 *                                 no new migration ordered before an applied one
 *   3  schema:unique-agreement    every UNIQUE index the migrations leave behind
 *                                 is the one the Prisma model declares
 *   4  typecheck
 *   5  lint                       errors fail; warnings are reported, not fatal
 *   6  test:unit
 *   7  build                      the step CI skips
 *
 * DATABASE SAFETY (non-negotiable)
 * --------------------------------
 * This harness NEVER opens a database connection. The repo `.env` can point at
 * PRODUCTION, and `npm run validate:security` chains eleven `tsx` scripts that
 * connect and write. None of those run here — they are listed as SKIPPED with a
 * reason so the omission is visible rather than silent.
 *
 * Two defences, not one:
 *   * every child process is spawned with DATABASE_URL / DATABASE_URL_UNPOOLED
 *     / POSTGRES_URL / DIRECT_URL forced to an unroutable placeholder, so a
 *     connection attempt fails instead of reaching a real server;
 *   * `assertNoDatabaseAccess` refuses to spawn a command that matches a
 *     DB-touching pattern (`migrate deploy`, `db push`, `db execute`, `tsx`…).
 *
 * `prisma validate` and `next build` do not connect — but they DO read
 * `env("DATABASE_URL")` from the datasource block and fail if it is unset,
 * which is why a placeholder is supplied rather than nothing.
 *
 * USAGE
 *   npm run verify:stack                 # everything
 *   npm run verify:stack -- --skip-build # everything except the slow step
 *   npm run verify:stack -- --only=migrations:order,schema:unique-agreement
 *   npm run verify:stack -- --baseline=origin/main
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(repoRoot, "prisma", "migrations");
const prismaDir = join(repoRoot, "prisma");

/** Unroutable on purpose: port 1 on loopback refuses instantly. */
const PLACEHOLDER_DB_URL =
  "postgresql://verify-stack:no-connection@127.0.0.1:1/verify_stack_never_connects";

const FAIL_OUTPUT_LINES = 20;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : true;
};
const skipBuild = flag("skip-build") === true;
const onlySteps = typeof flag("only") === "string" ? String(flag("only")).split(",").map((s) => s.trim()) : null;
const baselineRef = typeof flag("baseline") === "string" ? String(flag("baseline")) : process.env.VERIFY_BASELINE_REF || "origin/main";

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const useColour = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (useColour ? `\u001b[${code}m${s}\u001b[0m` : s);
const bold = (s) => paint("1", s);
const red = (s) => paint("31", s);
const green = (s) => paint("32", s);
const yellow = (s) => paint("33", s);
const dim = (s) => paint("2", s);

function heading(text) {
  console.log(`\n${bold("─".repeat(78))}`);
  console.log(bold(text));
  console.log(bold("─".repeat(78)));
}

const formatDuration = (ms) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

// ---------------------------------------------------------------------------
// Database-access guard
// ---------------------------------------------------------------------------

/**
 * Commands that reach a real server. Refusing by pattern, rather than trusting
 * the step list to stay correct, is the point: a future edit that adds
 * `prisma migrate deploy` to this harness fails loudly instead of running
 * against whatever `.env` names.
 */
const DB_ACCESS_PATTERNS = [
  /\bmigrate\s+(deploy|dev|reset|resolve|diff)\b/,
  /\bdb\s+(push|pull|execute|seed)\b/,
  /\bprisma:migrate\b/,
  /\btsx\b/,
  /\bpsql\b/,
  /\bverify:governance\b/,
  /\btest:(security|rbac|integrity|tenant-guard|platform-admins|draft-concurrency|rls-restricted|tenant-e2e|receipt-isolation|signing-upgrade|migration-session)\b/,
  /\bcheck:(rls-role|backup-coverage)\b/,
  /\bbackup:verify\b/,
  /\bvalidate:security\b/,
];

function assertNoDatabaseAccess(command, args) {
  const line = [command, ...args].join(" ");
  const hit = DB_ACCESS_PATTERNS.find((p) => p.test(line));
  if (hit) {
    throw new Error(
      `verify-stack refuses to run a database-touching command: "${line}" (matched ${hit}). ` +
        `The repo .env may point at PRODUCTION. Report the step as SKIPPED instead.`,
    );
  }
}

/** Child env with every database URL forced to the unroutable placeholder. */
function childEnv() {
  return {
    ...process.env,
    DATABASE_URL: PLACEHOLDER_DB_URL,
    DATABASE_URL_UNPOOLED: PLACEHOLDER_DB_URL,
    DIRECT_URL: PLACEHOLDER_DB_URL,
    POSTGRES_URL: PLACEHOLDER_DB_URL,
    POSTGRES_PRISMA_URL: PLACEHOLDER_DB_URL,
    NEXT_TELEMETRY_DISABLED: "1",
    CI: "1",
    FORCE_COLOR: "0",
  };
}

function runCommand(command, args) {
  assertNoDatabaseAccess(command, args);
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: childEnv(),
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 128 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return {
    exitCode: result.status ?? (result.error ? 1 : 0),
    output: result.error ? `${output}\n${result.error.message}` : output,
    durationMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// SQL scanning
// ---------------------------------------------------------------------------

/**
 * Strip comments and dollar-quoted bodies so the DDL regexes below cannot match
 * inside a `-- CREATE UNIQUE INDEX …` explanation or a PL/pgSQL trigger body.
 * Several migrations here contain both, and both would otherwise register as
 * real index changes.
 */
export function stripSqlNoise(sql) {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
      continue;
    }
    if (sql[i] === "'") {
      const end = sql.indexOf("'", i + 1);
      i = end === -1 ? sql.length : end + 1;
      out += "''";
      continue;
    }
    const dollar = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i));
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end === -1 ? sql.length : end + tag.length;
      out += " '' ";
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

/** `"a", "b"` / `a, b` → ["a","b"]. Expressions yield null (not comparable). */
function parseColumnList(raw) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of raw) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);

  const columns = [];
  for (const part of parts) {
    const cleaned = part
      .trim()
      .replace(/\s+(ASC|DESC|NULLS\s+(FIRST|LAST))\b/gi, "")
      .replace(/\s+\w+_ops\b/gi, "")
      .trim();
    const quoted = /^"([^"]+)"$/.exec(cleaned);
    if (quoted) {
      columns.push(quoted[1]);
      continue;
    }
    if (/^[A-Za-z_]\w*$/.test(cleaned)) {
      columns.push(cleaned);
      continue;
    }
    return null; // functional / expression index — not expressible as @@unique
  }
  return columns.length ? columns : null;
}

const ident = String.raw`(?:"([^"]+)"|([A-Za-z_]\w*))`;
const pick = (a, b) => a ?? b;

/**
 * Split cleaned SQL into statements. Safe as a naive split because
 * `stripSqlNoise` has already removed comments and collapsed every string and
 * dollar-quoted body to `''`, so no `;` survives inside a literal.
 */
function splitStatements(sql) {
  return sql.split(";").map((s) => s.trim()).filter(Boolean);
}

/**
 * Replay every migration in the order the repo's runner uses and return the
 * UNIQUE indexes still standing at the end. Tracking the FINAL state (rather
 * than every statement ever written) is what makes a later "DROP the old one,
 * CREATE the tenant-scoped one" migration read correctly.
 *
 * Statements are applied ONE AT A TIME IN FILE ORDER, not grouped by kind.
 * That is not a stylistic choice: 20260727170000_full_tenant_scope drops
 * "Role_tenantId_name_key" and immediately recreates it under the same name
 * without the WHERE clause. Handling every CREATE before every DROP inverts
 * that pair and leaves the index missing from the model — a silent false pass.
 *
 * `IF NOT EXISTS` is honoured for the same reason: 20260727100000 creates
 * "Role_tenantId_name_key" as a PARTIAL index, and a later
 * `CREATE UNIQUE INDEX IF NOT EXISTS` of the same name is a no-op against a
 * database that already has it.
 */
export function replayUniqueIndexes(orderedMigrationNames) {
  /** @type {Map<string, {table:string, columns:string[]|null, partial:boolean, migration:string}>} */
  const indexes = new Map();
  /** @type {Map<string, Set<string>>} table → migrations that touched it */
  const tableTouchedBy = new Map();
  const touch = (table, migration) => {
    if (!tableTouchedBy.has(table)) tableTouchedBy.set(table, new Set());
    tableTouchedBy.get(table).add(migration);
  };

  const RE_CREATE_TABLE = new RegExp(
    String.raw`^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${ident}\s*\(([\s\S]*)\)[^)]*$`,
    "i",
  );
  const RE_CREATE_UNIQUE = new RegExp(
    String.raw`^CREATE\s+UNIQUE\s+INDEX\s+(?:CONCURRENTLY\s+)?(IF\s+NOT\s+EXISTS\s+)?${ident}\s+ON\s+(?:ONLY\s+)?${ident}\s*(?:USING\s+\w+\s*)?\(([\s\S]*?)\)\s*([\s\S]*)$`,
    "i",
  );
  const RE_ADD_UNIQUE = new RegExp(
    String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${ident}\s+ADD\s+CONSTRAINT\s+${ident}\s+UNIQUE\s*\(([^)]*)\)`,
    "i",
  );
  const RE_DROP_INDEX = /^DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?([\s\S]+)$/i;
  const RE_DROP_CONSTRAINT = new RegExp(
    String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${ident}\s+DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?${ident}`,
    "i",
  );
  const RE_DROP_TABLE = new RegExp(String.raw`^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${ident}`, "i");
  const RE_RENAME_TABLE = new RegExp(
    String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?${ident}\s+RENAME\s+TO\s+${ident}`,
    "i",
  );
  const RE_RENAME_INDEX = new RegExp(
    String.raw`^ALTER\s+INDEX\s+(?:IF\s+EXISTS\s+)?${ident}\s+RENAME\s+TO\s+${ident}`,
    "i",
  );
  const RE_ALTER_ANY = new RegExp(String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${ident}`, "i");

  for (const name of orderedMigrationNames) {
    const file = join(migrationsDir, name, "migration.sql");
    if (!existsSync(file)) continue;

    for (const statement of splitStatements(stripSqlNoise(readFileSync(file, "utf8")))) {
      let m;

      if ((m = RE_CREATE_TABLE.exec(statement))) {
        const table = pick(m[1], m[2]);
        touch(table, name);
        const inline = new RegExp(String.raw`CONSTRAINT\s+${ident}\s+UNIQUE\s*\(([^)]*)\)`, "gi");
        let c;
        while ((c = inline.exec(m[3]))) {
          indexes.set(pick(c[1], c[2]), {
            table,
            columns: parseColumnList(c[3]),
            partial: false,
            migration: name,
          });
        }
        continue;
      }

      if ((m = RE_CREATE_UNIQUE.exec(statement))) {
        const ifNotExists = Boolean(m[1]);
        const indexName = pick(m[2], m[3]);
        const table = pick(m[4], m[5]);
        touch(table, name);
        if (ifNotExists && indexes.has(indexName)) continue; // genuine no-op
        indexes.set(indexName, {
          table,
          columns: parseColumnList(m[6]),
          partial: /\bWHERE\b/i.test(m[7] ?? ""),
          migration: name,
        });
        continue;
      }

      if ((m = RE_ADD_UNIQUE.exec(statement))) {
        const table = pick(m[1], m[2]);
        touch(table, name);
        indexes.set(pick(m[3], m[4]), {
          table,
          columns: parseColumnList(m[5]),
          partial: false,
          migration: name,
        });
        continue;
      }

      if ((m = RE_DROP_INDEX.exec(statement))) {
        for (const raw of m[1].split(",")) {
          const cleaned = raw.trim().replace(/\s+(CASCADE|RESTRICT)$/i, "").trim();
          const hit = /^(?:"([^"]+)"|([A-Za-z_]\w*))$/.exec(cleaned.split(".").pop() ?? "");
          if (hit) indexes.delete(pick(hit[1], hit[2]));
        }
        continue;
      }

      if ((m = RE_DROP_CONSTRAINT.exec(statement))) {
        touch(pick(m[1], m[2]), name);
        indexes.delete(pick(m[3], m[4]));
        continue;
      }

      if ((m = RE_DROP_TABLE.exec(statement))) {
        const table = pick(m[1], m[2]);
        for (const [k, v] of [...indexes]) if (v.table === table) indexes.delete(k);
        continue;
      }

      if ((m = RE_RENAME_TABLE.exec(statement))) {
        const from = pick(m[1], m[2]);
        const to = pick(m[3], m[4]);
        for (const v of indexes.values()) if (v.table === from) v.table = to;
        touch(to, name);
        continue;
      }

      if ((m = RE_RENAME_INDEX.exec(statement))) {
        const from = pick(m[1], m[2]);
        const to = pick(m[3], m[4]);
        if (indexes.has(from)) {
          indexes.set(to, { ...indexes.get(from), migration: name });
          indexes.delete(from);
        }
        continue;
      }

      // Anything else naming a table still counts as "this migration touched it".
      if ((m = RE_ALTER_ANY.exec(statement))) touch(pick(m[1], m[2]), name);
    }
  }

  return { indexes, tableTouchedBy };
}

// ---------------------------------------------------------------------------
// Prisma schema scanning
// ---------------------------------------------------------------------------

/**
 * Read every prisma/*.prisma file, not just schema.prisma. The models are split
 * across sixteen files here, and a check that reads only schema.prisma misses
 * governance, journeys, bot-* and the rest — the same blind spot that let the
 * governance models go unscanned by tenantSchemaContract.
 */
export function readPrismaModels() {
  const files = readdirSync(prismaDir)
    .filter((f) => f.endsWith(".prisma"))
    .map((f) => join(prismaDir, f));

  /** @type {Map<string, {model:string, file:string, uniques:{columns:string[], source:string}[]}>} */
  const models = new Map();

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const modelRe = /^\s*model\s+(\w+)\s*\{/gm;
    let m;
    while ((m = modelRe.exec(text))) {
      const modelName = m[1];
      let depth = 1;
      let i = modelRe.lastIndex;
      while (i < text.length && depth > 0) {
        if (text[i] === "{") depth += 1;
        else if (text[i] === "}") depth -= 1;
        i += 1;
      }
      const body = text.slice(modelRe.lastIndex, i - 1);
      const lines = body
        .split("\n")
        .map((l) => l.replace(/\/\/.*$/, "").trim())
        .filter(Boolean);

      let table = modelName;
      const fieldColumn = new Map();
      const uniques = [];

      for (const line of lines) {
        const mapped = /^@@map\("([^"]+)"\)/.exec(line);
        if (mapped) {
          table = mapped[1];
          continue;
        }
        const field = /^(\w+)\s+(\S+)(.*)$/.exec(line);
        if (field && !line.startsWith("@@")) {
          const colMap = /@map\("([^"]+)"\)/.exec(field[3]);
          fieldColumn.set(field[1], colMap ? colMap[1] : field[1]);
          if (/(^|\s)@unique(\s|\(|$)/.test(field[3])) {
            uniques.push({ fields: [field[1]], source: `@unique on ${field[1]}` });
          }
        }
        const blockUnique = /^@@unique\(\s*(?:fields:\s*)?\[([^\]]*)\]/.exec(line);
        if (blockUnique) {
          uniques.push({
            fields: blockUnique[1].split(",").map((f) => f.trim()).filter(Boolean),
            source: line,
          });
        }
      }

      models.set(table, {
        model: modelName,
        file: file.slice(repoRoot.length + 1).replace(/\\/g, "/"),
        uniques: uniques.map((u) => ({
          columns: u.fields.map((f) => fieldColumn.get(f) ?? f),
          source: u.source,
        })),
      });
    }
  }
  return models;
}

// ---------------------------------------------------------------------------
// Migration inventory + ordering
// ---------------------------------------------------------------------------

function migrationDirectories() {
  return readdirSync(migrationsDir)
    .filter((name) => {
      const full = join(migrationsDir, name);
      return statSync(full).isDirectory();
    })
    .sort();
}

/**
 * `scripts/apply-migrations.mjs` (the runner this repo actually deploys with)
 * orders by `Number.parseInt(name, 10)` — NOT lexicographically. Legacy
 * `0_init … 80_*` therefore run before the `2026…` timestamped family, which is
 * the intent. This check models the runner's real order; modelling Prisma's
 * lexicographic order instead would report a false failure on every legacy name.
 */
function runnerOrder(names) {
  return [...names].sort((a, b) => {
    const diff = Number.parseInt(a, 10) - Number.parseInt(b, 10);
    return diff !== 0 ? diff : a.localeCompare(b);
  });
}

function parseMigrationName(name) {
  const m = /^(\d+)_(.+)$/.exec(name);
  if (!m) return { name, kind: "invalid" };
  const digits = m[1];
  if (digits.length === 14) {
    const [y, mo, d, h, mi, s] = [
      +digits.slice(0, 4), +digits.slice(4, 6), +digits.slice(6, 8),
      +digits.slice(8, 10), +digits.slice(10, 12), +digits.slice(12, 14),
    ];
    const asDate = new Date(Date.UTC(y, mo - 1, d));
    const validDate =
      y >= 2000 && mo >= 1 && mo <= 12 && d >= 1 && asDate.getUTCMonth() === mo - 1 && asDate.getUTCDate() === d;
    const validTime = h <= 23 && mi <= 59 && s <= 59;
    return {
      name,
      kind: "timestamp",
      prefix: digits,
      numeric: Number(digits),
      validDate,
      validTime,
      label: `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")} ${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`,
    };
  }
  if (digits.length <= 4) {
    return { name, kind: "legacy", prefix: digits, numeric: Number(digits), validDate: true, validTime: true };
  }
  return { name, kind: "odd", prefix: digits, numeric: Number(digits), validDate: false, validTime: false };
}

function baselineMigrations() {
  const res = spawnSync("git", ["ls-tree", "-d", "--name-only", `${baselineRef}:prisma/migrations`], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (res.status !== 0) return null;
  return new Set(
    res.stdout.split("\n").map((l) => l.trim().replace(/\/$/, "")).filter(Boolean),
  );
}

function checkMigrationOrdering() {
  const lines = [];
  const failures = [];
  const warnings = [];

  const names = migrationDirectories();
  const ordered = runnerOrder(names);
  const parsed = ordered.map(parseMigrationName);

  lines.push(`${names.length} migration directories; runner order = numeric prefix (scripts/apply-migrations.mjs).`);

  // -- names ---------------------------------------------------------------
  for (const p of parsed) {
    if (p.kind === "invalid") {
      failures.push(`${p.name}: not "<digits>_<slug>" — the runner's /^\\d+_/ filter would SKIP it entirely.`);
      continue;
    }
    if (p.kind === "odd") {
      failures.push(`${p.name}: numeric prefix "${p.prefix}" is neither a legacy sequence (<=4 digits) nor a 14-digit timestamp.`);
      continue;
    }
    if (p.kind === "timestamp" && !p.validDate) {
      failures.push(`${p.name}: "${p.prefix.slice(0, 8)}" is not a real calendar date.`);
    }
    if (!existsSync(join(migrationsDir, p.name, "migration.sql"))) {
      failures.push(`${p.name}: no migration.sql — the runner skips it, so its DDL never reaches any database.`);
    }
  }

  // Out-of-range HHMMSS fields. This repo deliberately uses the minute slot as a
  // sub-sequence counter (…146000, …147000, …237000), which still sorts and
  // still orders correctly — so it is a naming warning, never a failure.
  const overflow = parsed.filter((p) => p.kind === "timestamp" && p.validDate && !p.validTime);
  if (overflow.length) {
    lines.push(
      dim(
        `${overflow.length} migration(s) carry an out-of-range HHMMSS field (the repo's sub-sequence convention, ` +
          `e.g. ${overflow[0].name}). Ordering is unaffected — reported, not failed.`,
      ),
    );
  }

  // -- collisions ----------------------------------------------------------
  const byPrefix = new Map();
  for (const p of parsed) {
    if (p.kind === "invalid") continue;
    if (!byPrefix.has(p.prefix)) byPrefix.set(p.prefix, []);
    byPrefix.get(p.prefix).push(p.name);
  }
  for (const [prefix, group] of byPrefix) {
    if (group.length > 1) {
      failures.push(
        `prefix collision "${prefix}": ${group.join(", ")} — the runner's numeric sort makes their relative order undefined.`,
      );
    }
  }

  // -- chronological within the timestamp family ---------------------------
  const timestamps = parsed.filter((p) => p.kind === "timestamp");
  let monotonic = true;
  for (let i = 1; i < timestamps.length; i += 1) {
    if (timestamps[i].numeric <= timestamps[i - 1].numeric) {
      monotonic = false;
      failures.push(
        `${timestamps[i].name} does not sort after ${timestamps[i - 1].name} — timestamps must increase monotonically.`,
      );
    }
  }
  lines.push(
    `Timestamped family: ${timestamps.length} migrations, ${timestamps[0]?.label ?? "-"} → ${timestamps.at(-1)?.label ?? "-"}, ` +
      `${monotonic ? "strictly increasing" : red("NOT strictly increasing")}.`,
  );

  // -- new-vs-applied regression -------------------------------------------
  const baseline = baselineMigrations();
  if (!baseline) {
    lines.push(
      `SKIPPED sub-check: cannot resolve baseline ref "${baselineRef}" (git ls-tree failed). ` +
        `Ordering-against-already-applied was NOT verified. Pass --baseline=<ref> to enable.`,
    );
  } else {
    const added = ordered.filter((n) => !baseline.has(n));
    const baselineMax = Math.max(
      ...parsed.filter((p) => baseline.has(p.name) && p.kind === "timestamp").map((p) => p.numeric),
      0,
    );
    const baselineMaxName = parsed.find((p) => p.numeric === baselineMax)?.name ?? "-";
    lines.push(
      `Baseline ${baselineRef}: ${baseline.size} migrations (newest timestamped: ${baselineMaxName}). ` +
        `This head adds ${added.length}.`,
    );
    for (const name of added) {
      const p = parseMigrationName(name);
      if (p.kind !== "timestamp") {
        warnings.push(`${name}: added by this head but uses a legacy numeric prefix; new migrations should be timestamped.`);
        continue;
      }
      if (p.numeric <= baselineMax) {
        failures.push(
          `${name} is NEW but its timestamp is not after ${baselineMaxName}, which is already applied above it. ` +
            `A database that has applied ${baselineMaxName} will run ${name} afterwards regardless of the name, ` +
            `so any state this migration assumes from its nominal position is wrong.`,
        );
      }
    }
    if (added.length) lines.push(`Added by this head: ${added.join(", ")}`);
  }

  // -- structural note ------------------------------------------------------
  const legacyMax = Math.max(...parsed.filter((p) => p.kind === "legacy").map((p) => p.numeric), 0);
  if (legacyMax > 0 && timestamps.length) {
    lines.push(
      dim(
        `Note: legacy names ("80_…") sort AFTER timestamped names ("20260810…") lexicographically, ` +
          `so stock \`prisma migrate deploy\` would order them differently from this repo's runner. ` +
          `Not a defect while prisma:migrate is the deploy path — it is why this check uses numeric order.`,
      ),
    );
  }

  return { failures, warnings, lines, ordered };
}

// ---------------------------------------------------------------------------
// Schema-vs-migration UNIQUE agreement
// ---------------------------------------------------------------------------

const key = (columns) => [...columns].sort().join(",");

function checkUniqueAgreement(orderedMigrations, addedMigrations) {
  const lines = [];
  const failures = [];
  const warnings = [];

  const { indexes, tableTouchedBy } = replayUniqueIndexes(orderedMigrations);
  const models = readPrismaModels();

  lines.push(
    `Replayed ${orderedMigrations.length} migrations → ${indexes.size} UNIQUE indexes standing across ${new Set([...indexes.values()].map((v) => v.table)).size} tables; ` +
      `read ${models.size} models from prisma/*.prisma.`,
  );

  const isNew = (table) => {
    const touched = tableTouchedBy.get(table);
    return touched ? [...touched].some((mig) => addedMigrations.has(mig)) : false;
  };

  const byTable = new Map();
  for (const [name, info] of indexes) {
    if (!byTable.has(info.table)) byTable.set(info.table, []);
    byTable.get(info.table).push({ name, ...info });
  }

  let expressionSkipped = 0;
  let partialSkipped = 0;
  const orphanTables = [];

  for (const [table, dbIndexes] of byTable) {
    const model = models.get(table);
    if (!model) {
      orphanTables.push(table);
      continue;
    }

    const dbFull = dbIndexes.filter((i) => !i.partial && i.columns);
    const dbPartialKeys = new Set(dbIndexes.filter((i) => i.partial && i.columns).map((i) => key(i.columns)));
    expressionSkipped += dbIndexes.filter((i) => !i.columns).length;
    partialSkipped += dbIndexes.filter((i) => i.partial).length;

    const modelKeys = new Map(model.uniques.map((u) => [key(u.columns), u]));
    const dbKeys = new Map(dbFull.map((i) => [key(i.columns), i]));

    // DB has it, model does not → next `prisma migrate dev` DROPS it.
    for (const [k, index] of dbKeys) {
      if (modelKeys.has(k)) continue;
      const message =
        `${table}: migration ${index.migration} leaves UNIQUE (${index.columns.join(", ")}) as "${index.name}", ` +
        `but model ${model.model} (${model.file}) declares no matching @@unique. ` +
        `The next \`prisma migrate dev\` will write a migration DROPPING it and restoring the model's shape ` +
        `[${model.uniques.map((u) => `(${u.columns.join(", ")})`).join(" ") || "none"}].`;
      (isNew(table) ? failures : warnings).push(message);
    }

    // Model has it, DB does not → the constraint is declared but never enforced.
    for (const [k, unique] of modelKeys) {
      if (dbKeys.has(k)) continue;
      if (dbPartialKeys.has(k)) {
        warnings.push(
          `${table}: model ${model.model} declares @@unique(${unique.columns.join(", ")}) but the database index on those ` +
            `columns is PARTIAL (has a WHERE clause). Prisma cannot express that, so \`migrate dev\` would replace it with a total index.`,
        );
        continue;
      }
      const message =
        `${table}: model ${model.model} (${model.file}) declares unique (${unique.columns.join(", ")}) — ` +
        `\`${unique.source}\` — but no migration creates a matching UNIQUE index. The constraint is not enforced in the database.`;
      (isNew(table) ? failures : warnings).push(message);
    }
  }

  // Models whose table never appears in any migration at all.
  for (const [table, model] of models) {
    if (byTable.has(table)) continue;
    if (!model.uniques.length) continue;
    if (tableTouchedBy.has(table)) continue;
    warnings.push(
      `${table}: model ${model.model} declares ${model.uniques.length} unique constraint(s) but no migration mentions the table.`,
    );
  }

  if (orphanTables.length) {
    lines.push(
      dim(`${orphanTables.length} table(s) with UNIQUE indexes have no Prisma model (not comparable): ${orphanTables.sort().join(", ")}`),
    );
  }
  if (partialSkipped || expressionSkipped) {
    lines.push(
      dim(`${partialSkipped} partial and ${expressionSkipped} expression index(es) excluded — neither is expressible as @@unique.`),
    );
  }
  lines.push(
    `Findings scoped to tables this head's migrations touch are failures; everything else is pre-existing drift, reported as a warning.`,
  );

  return { failures, warnings, lines };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

const results = [];

function record(name, status, detail) {
  results.push({ name, status, ...detail });
}

function reportInline(name, { status, durationMs, failures = [], warnings = [], lines = [] }) {
  heading(`${name}  ${status === "PASS" ? green(status) : status === "WARN" ? yellow(status) : red(status)}  ${dim(formatDuration(durationMs))}`);
  for (const line of lines) console.log(`  ${line}`);
  for (const w of warnings) console.log(`  ${yellow("WARN")} ${w}`);
  for (const f of failures) console.log(`  ${red("FAIL")} ${f}`);
}

/** Print the first N lines that look like the actual error, not the preamble. */
function firstRelevantLines(output, limit = FAIL_OUTPUT_LINES) {
  const all = output.split(/\r?\n/);
  const signal = /(^|\s)(error|Error|ERROR|✖|✗|failed|Failed|FAIL|not ok|Type error|Module not found|Cannot find|✘)/;
  const firstHit = all.findIndex((l) => signal.test(l));
  const start = firstHit === -1 ? 0 : Math.max(0, firstHit - 2);
  return all.slice(start, start + limit).join("\n");
}

function runShellStep({ id, title, command, args, evaluate }) {
  if (onlySteps && !onlySteps.includes(id)) {
    record(id, "SKIPPED", { durationMs: 0, note: "not selected by --only" });
    return;
  }
  heading(`${title}   ${dim(`$ ${[command, ...args].join(" ")}`)}`);
  const { exitCode, output, durationMs } = runCommand(command, args);
  const verdict = evaluate ? evaluate({ exitCode, output }) : { status: exitCode === 0 ? "PASS" : "FAIL" };
  const status = verdict.status;
  console.log(
    `  ${status === "PASS" ? green("PASS") : status === "WARN" ? yellow("WARN") : red("FAIL")} ` +
      `exit=${exitCode} ${dim(formatDuration(durationMs))}${verdict.note ? ` — ${verdict.note}` : ""}`,
  );
  if (status === "FAIL") {
    console.log(red(`\n  first ${FAIL_OUTPUT_LINES} relevant lines of output:`));
    for (const line of firstRelevantLines(output).split("\n")) console.log(`  │ ${line}`);
  }
  record(id, status, { exitCode, durationMs, note: verdict.note, output });
}

function runInlineStep({ id, title, run }) {
  if (onlySteps && !onlySteps.includes(id)) {
    record(id, "SKIPPED", { durationMs: 0, note: "not selected by --only" });
    return null;
  }
  const started = Date.now();
  const outcome = run();
  const durationMs = Date.now() - started;
  const status = outcome.failures.length ? "FAIL" : outcome.warnings.length ? "WARN" : "PASS";
  reportInline(title, { ...outcome, status, durationMs });
  record(id, status, {
    exitCode: outcome.failures.length ? 1 : 0,
    durationMs,
    note:
      `${outcome.failures.length} failure(s), ${outcome.warnings.length} warning(s)`,
  });
  return outcome;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Guarded so the checks above can be imported and unit-tested without the whole
 * harness — including `npm run build` — executing as an import side effect.
 */
function main() {
console.log(bold("\nverify-stack — integrated-head verification"));
const headRes = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8", shell: process.platform === "win32" });
console.log(dim(`HEAD ${headRes.stdout?.trim() || "unknown"}   baseline ${baselineRef}   node ${process.version}`));
console.log(dim(`DATABASE_URL forced to ${PLACEHOLDER_DB_URL} for every child process.`));

const totalStarted = Date.now();

// 1 — prisma validate
runShellStep({
  id: "prisma:validate",
  title: "1  prisma:validate",
  command: "npx",
  args: ["prisma", "validate", "--schema", "./prisma"],
});

// 2 — migration ordering
const ordering = runInlineStep({
  id: "migrations:order",
  title: "2  migrations:order",
  run: checkMigrationOrdering,
});

// 3 — schema vs migration UNIQUE agreement
const orderedMigrations = ordering?.ordered ?? runnerOrder(migrationDirectories());
const baseline = baselineMigrations();
const addedMigrations = new Set(
  baseline ? orderedMigrations.filter((n) => !baseline.has(n)) : [],
);
runInlineStep({
  id: "schema:unique-agreement",
  title: "3  schema:unique-agreement",
  run: () => checkUniqueAgreement(orderedMigrations, addedMigrations),
});

// 4 — typecheck
runShellStep({
  id: "typecheck",
  title: "4  typecheck",
  command: "npm",
  args: ["run", "typecheck"],
});

// 5 — lint (errors fail; warnings do not)
runShellStep({
  id: "lint",
  title: "5  lint",
  command: "npm",
  args: ["run", "lint"],
  evaluate: ({ exitCode, output }) => {
    const summary = /(\d+)\s+errors?,\s+(\d+)\s+warnings?/.exec(output);
    const errors = summary ? Number(summary[1]) : exitCode === 0 ? 0 : null;
    const warns = summary ? Number(summary[2]) : 0;
    if (errors === null) {
      return { status: "FAIL", note: `eslint exited ${exitCode} without a parseable summary — treat as a crash` };
    }
    if (errors > 0) return { status: "FAIL", note: `${errors} error(s), ${warns} warning(s)` };
    return {
      status: warns > 0 ? "WARN" : "PASS",
      note: `0 errors, ${warns} warning(s) — warnings are acceptable`,
    };
  },
});

// 6 — unit tests
runShellStep({
  id: "test:unit",
  title: "6  test:unit",
  command: "npm",
  args: ["run", "test:unit"],
  evaluate: ({ exitCode, output }) => {
    const pass = /^# pass (\d+)/m.exec(output);
    const fail = /^# fail (\d+)/m.exec(output);
    const note = pass ? `${pass[1]} passed, ${fail?.[1] ?? "?"} failed` : undefined;
    return { status: exitCode === 0 ? "PASS" : "FAIL", note };
  },
});

// 7 — production build (the step CI skips)
if (skipBuild) {
  record("build", "SKIPPED", { durationMs: 0, note: "--skip-build" });
  heading(`7  build   ${yellow("SKIPPED")} (--skip-build)`);
} else {
  runShellStep({
    id: "build",
    title: "7  build",
    command: "npm",
    args: ["run", "build"],
  });
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/** Steps of `validate:security` that this harness deliberately does not run. */
const DB_STEPS_SKIPPED = [
  ["verify:governance", "connects to the database (tsx scripts/verify-governance.ts)"],
  ["test:security", "connects to the database"],
  ["test:rbac", "connects to the database"],
  ["test:integrity", "connects to the database"],
  ["test:tenant-guard", "connects to the database"],
  ["test:platform-admins", "connects to the database (writes rows)"],
  ["test:draft-concurrency", "connects to the database (writes rows)"],
  ["test:rls-restricted", "connects to the database as a restricted role"],
  ["test:tenant-e2e", "connects to the database (writes rows)"],
  ["test:receipt-isolation", "connects to the database (writes rows)"],
  ["test:migration-session", "connects to the database"],
];

heading("RESULT");

const width = Math.max(...results.map((r) => r.name.length), ...DB_STEPS_SKIPPED.map(([n]) => n.length), 24);
const row = (name, status, timing, note) =>
  `  ${name.padEnd(width)}  ${status.padEnd(9)}  ${(timing ?? "").padStart(7)}  ${note ?? ""}`;

console.log(row("STEP", "STATUS", "TIME", "NOTES"));
console.log(`  ${"-".repeat(width)}  ${"-".repeat(9)}  ${"-".repeat(7)}  ${"-".repeat(30)}`);
for (const r of results) {
  const colour = r.status === "PASS" ? green : r.status === "WARN" ? yellow : r.status === "SKIPPED" ? dim : red;
  console.log(
    row(r.name, colour(r.status), r.durationMs ? formatDuration(r.durationMs) : "-", r.note ?? (r.exitCode ? `exit ${r.exitCode}` : "")),
  );
}
for (const [name, reason] of DB_STEPS_SKIPPED) {
  console.log(row(name, dim("SKIPPED"), "-", dim(reason)));
}

const failed = results.filter((r) => r.status === "FAIL");
const warned = results.filter((r) => r.status === "WARN");
console.log(
  `\n  ${failed.length ? red(`${failed.length} step(s) FAILED`) : green("all executed steps passed")}` +
    `${warned.length ? yellow(`, ${warned.length} with warnings`) : ""}` +
    `  ${dim(`total ${formatDuration(Date.now() - totalStarted)}`)}`,
);
if (failed.length) {
  console.log(red(`  failed steps: ${failed.map((f) => `${f.name} (exit ${f.exitCode})`).join(", ")}`));
}
console.log(
  dim(
    `\n  Not covered by this harness: anything requiring a live database (listed SKIPPED above),\n` +
      `  and runtime behaviour. A green table means the head compiles, builds and its DDL agrees\n` +
      `  with its models — not that the features work.`,
  ),
);

process.exit(failed.length ? 1 : 0);
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1]);
if (invokedDirectly) main();

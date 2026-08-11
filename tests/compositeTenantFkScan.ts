/**
 * READING THE COMPOSITE TENANT FOREIGN KEYS OUT OF THE MIGRATION SQL, AND OUT OF
 * A LIVE POSTGRESQL CATALOG.
 *
 * The constraints this file finds are the shape
 *
 *     FOREIGN KEY ("tenantId", "<fk>") REFERENCES "<Parent>"("tenantId", "id")
 *
 * and they are the LAST line of defence against a forged id crossing tenants.
 * That is not a claim from a design document — the two-tenant harness measured
 * it. Drop the tenant predicate from `claimPartStock`'s row lock alone, or from
 * its `updateMany` alone, and the harness stays green, because the still-filtered
 * `findFirst` bails first. Remove both and the decrement runs; what rolls the
 * transaction back is `JobCardItem(tenantId, partId) → Part(tenantId, id)`.
 * `Quote_tenantId_revisionOfId_fkey` is load-bearing in the same way for quote
 * revisions.
 *
 * WHY THEY NEED A GUARD OF THEIR OWN. These constraints live ONLY in raw
 * migration SQL. They are not in schema.prisma — Prisma's `@relation` cannot
 * express a foreign key over (tenantId, id) (see the note in
 * compositeTenantFkContract.test.ts). So Prisma does not know they exist,
 * `prisma migrate diff` never mentions them, and a schema-driven migration can
 * drop and recreate the underlying relations without the word "tenant" appearing
 * anywhere in the diff. It has already happened once by hand:
 * 20260805238000_signing_job_request_cascade drops `SigningJob_request_fkey` and
 * re-adds it to change the delete rule. That migration got it right. The next one
 * has nothing checking it.
 *
 * Split out of the test file so the same parse can be driven from a scratch
 * script, and so the parser itself can be unit-tested against synthetic SQL
 * instead of only against the repository that happens to be checked out.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type CompositeTenantFk = {
  /** Table the constraint is ON. */
  table: string;
  /** Constraint name — unique per table in PostgreSQL, so table+name is the key. */
  constraint: string;
  /** Referencing columns, in constraint order. */
  columns: string[];
  /** Table the constraint points AT. */
  referencedTable: string;
  /** Referenced columns, in constraint order. */
  referencedColumns: string[];
  /** Migration directory whose SQL last declared it. Diagnostics only. */
  migration: string;
};

/** table + constraint name — the identity PostgreSQL itself uses. */
export function fkKey(table: string, constraint: string): string {
  return `${table}.${constraint}`;
}

/**
 * Strip SQL comments without being fooled by an apostrophe inside one.
 *
 * This is a scanner rather than a regex on purpose. `-- don't` inside a comment
 * would open a string literal for any quote-tracking regex and swallow the rest
 * of the file, silently dropping every constraint declared after it — a parser
 * that under-reports is exactly the failure this whole file exists to prevent,
 * so it must not have a way to under-report quietly.
 *
 * Dollar-quoted blocks are deliberately NOT treated as strings. Every constraint
 * in this repository is declared inside `DO $$ BEGIN … END $$`, so skipping
 * their contents would find nothing at all.
 */
export function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'") {
      out += c;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            out += "''";
            i += 2;
            continue;
          }
          out += "'";
          i += 1;
          break;
        }
        out += sql[i];
        i += 1;
      }
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      let depth = 1;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      out += " ";
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function identifiers(list: string): string[] {
  return list
    .split(",")
    .map((c) => c.trim().replace(/^"(.*)"$/, "$1"))
    .filter((c) => c.length > 0);
}

function unquote(name: string): string {
  return name.replace(/^"(.*)"$/, "$1");
}

/**
 * A composite tenant FK is a MULTI-COLUMN foreign key that carries `tenantId`.
 *
 * `columns.length > 1` is the whole point: every table also has a single-column
 * `"X_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")`, which
 * says the row belongs to a tenant but says nothing about whether its PARENT
 * does. Those are not what stopped the forged-partId attack and must not be
 * counted as if they were.
 *
 * `includes` rather than `columns[0] === "tenantId"` because column order in a
 * composite key is free; a future `("partId", "tenantId")` is the same defence
 * and must not slip past for being written the other way round.
 */
function isCompositeTenantFk(columns: string[]): boolean {
  return columns.length > 1 && columns.includes("tenantId");
}

export type FkEvent =
  | { at: number; kind: "add"; fk: Omit<CompositeTenantFk, "migration"> }
  | { at: number; kind: "drop"; table: string; constraint: string }
  | { at: number; kind: "drop-table"; tables: string[] };

const ADD_VIA_ALTER =
  /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?("?[A-Za-z_][\w$]*"?)\s+ADD\s+CONSTRAINT\s+("?[A-Za-z_][\w$]*"?)\s+FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+("?[A-Za-z_][\w$]*"?)\s*\(([^)]*)\)/gi;

const DROP_VIA_ALTER =
  /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?("?[A-Za-z_][\w$]*"?)\s+DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?("?[A-Za-z_][\w$]*"?)/gi;

const CREATE_TABLE_HEAD =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[A-Za-z_][\w$]*"?)\s*\(/gi;

/**
 * DROP TABLE TAKES THE CONSTRAINTS WITH IT, AND SAYS NOTHING ABOUT TENANTS.
 *
 * This is not a defensive hypothetical — it is the whole thesis, and it has
 * already happened in this repository. 20260802120000_retire_automation_rules
 * ends with two lines:
 *
 *     DROP TABLE IF EXISTS "AutomationLog";
 *     DROP TABLE IF EXISTS "AutomationRule";
 *
 * and those two lines removed FIVE composite tenant foreign keys —
 * AutomationLog→Lead, AutomationLog→AutomationRule, AutomationRule→PipelineStage
 * (twice) and AutomationRule→EmailTemplate. The migration is a perfectly good
 * one: it retires a duplicate automation engine and archives its history. The
 * word "tenant" does not appear in it. Nothing anywhere in the repository
 * recorded that five cross-tenant defences went with it.
 *
 * A parser that only tracked ADD/DROP CONSTRAINT would insist those five are
 * still declared, disagree with the catalog forever, and have to be silenced —
 * so it tracks table lifetime too.
 */
const DROP_TABLE =
  /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?((?:"?[A-Za-z_][\w$]*"?\s*,\s*)*"?[A-Za-z_][\w$]*"?)/gi;

const INLINE_CONSTRAINT =
  /CONSTRAINT\s+("?[A-Za-z_][\w$]*"?)\s+FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+("?[A-Za-z_][\w$]*"?)\s*\(([^)]*)\)/gi;

/**
 * Every add and drop of a composite tenant FK in one migration's SQL, in the
 * order the statements appear.
 *
 * ORDER MATTERS AND IS NOT COSMETIC. A migration is allowed to drop a constraint
 * and re-add it with different semantics — 20260805238000 does exactly that to
 * turn `ON DELETE RESTRICT` into `ON DELETE CASCADE`. Collecting adds and drops
 * into separate buckets would make that migration read as "dropped", and the
 * guard would then demand an acknowledgement for a constraint that is still
 * there. So both are emitted as positioned events and replayed in position order.
 */
export function scanMigrationSql(sql: string): FkEvent[] {
  const clean = stripSqlComments(sql);
  const events: FkEvent[] = [];

  ADD_VIA_ALTER.lastIndex = 0;
  for (let m = ADD_VIA_ALTER.exec(clean); m; m = ADD_VIA_ALTER.exec(clean)) {
    const columns = identifiers(m[3]);
    if (!isCompositeTenantFk(columns)) continue;
    events.push({
      at: m.index,
      kind: "add",
      fk: {
        table: unquote(m[1]),
        constraint: unquote(m[2]),
        columns,
        referencedTable: unquote(m[4]),
        referencedColumns: identifiers(m[5]),
      },
    });
  }

  DROP_VIA_ALTER.lastIndex = 0;
  for (let m = DROP_VIA_ALTER.exec(clean); m; m = DROP_VIA_ALTER.exec(clean)) {
    events.push({
      at: m.index,
      kind: "drop",
      table: unquote(m[1]),
      constraint: unquote(m[2]),
    });
  }

  DROP_TABLE.lastIndex = 0;
  for (let m = DROP_TABLE.exec(clean); m; m = DROP_TABLE.exec(clean)) {
    events.push({
      at: m.index,
      kind: "drop-table",
      tables: m[1].split(",").map((t) => unquote(t.trim())),
    });
  }

  // Table-constraint form: `CREATE TABLE "X" ( …, CONSTRAINT "…" FOREIGN KEY … )`.
  // No migration writes a COMPOSITE tenant FK this way today; every one of them
  // uses ALTER TABLE. It is parsed anyway because "the next migration is written
  // in the other supported syntax" is not a way this guard is allowed to go
  // blind — a constraint it cannot see is a constraint it cannot protect.
  CREATE_TABLE_HEAD.lastIndex = 0;
  for (let m = CREATE_TABLE_HEAD.exec(clean); m; m = CREATE_TABLE_HEAD.exec(clean)) {
    const table = unquote(m[1]);
    const bodyStart = m.index + m[0].length;
    let depth = 1;
    let i = bodyStart;
    while (i < clean.length && depth > 0) {
      if (clean[i] === "(") depth += 1;
      else if (clean[i] === ")") depth -= 1;
      i += 1;
    }
    const body = clean.slice(bodyStart, i - 1);
    INLINE_CONSTRAINT.lastIndex = 0;
    for (let c = INLINE_CONSTRAINT.exec(body); c; c = INLINE_CONSTRAINT.exec(body)) {
      const columns = identifiers(c[2]);
      if (!isCompositeTenantFk(columns)) continue;
      events.push({
        at: bodyStart + c.index,
        kind: "add",
        fk: {
          table,
          constraint: unquote(c[1]),
          columns,
          referencedTable: unquote(c[3]),
          referencedColumns: identifiers(c[4]),
        },
      });
    }
  }

  return events.sort((a, b) => a.at - b.at);
}

/**
 * Migration directories in the order the repository's own runner applies them.
 *
 * NUMERIC, not lexical, and the same filter as orderedMigrations() in
 * scripts/apply-migrations.mjs. Prisma's lexical order would run `10_…` before
 * `4_…`; using it here would replay drops and adds against each other in an
 * order production never sees.
 */
export function orderedMigrationDirs(migrationsDir: string): string[] {
  return readdirSync(migrationsDir)
    .filter((n) => /^\d+_/.test(n) && existsSync(join(migrationsDir, n, "migration.sql")))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
}

/**
 * Replay every migration in order and return the composite tenant FKs that are
 * still declared at the end of it.
 */
export function collectCompositeTenantFks(migrationsDir: string): Map<string, CompositeTenantFk> {
  const live = new Map<string, CompositeTenantFk>();
  for (const dir of orderedMigrationDirs(migrationsDir)) {
    const sql = readFileSync(join(migrationsDir, dir, "migration.sql"), "utf8");
    for (const event of scanMigrationSql(sql)) {
      if (event.kind === "add") {
        live.set(fkKey(event.fk.table, event.fk.constraint), { ...event.fk, migration: dir });
      } else if (event.kind === "drop") {
        live.delete(fkKey(event.table, event.constraint));
      } else {
        // Both directions. A constraint ON the dropped table obviously goes; one
        // POINTING AT it goes too, because PostgreSQL will not let the table be
        // dropped otherwise — either the statement said CASCADE and took the
        // constraint with it, or it had no dependants and there was nothing to
        // take. Modelling only the first direction would leave a constraint in
        // the recorded set whose parent table no longer exists.
        for (const table of event.tables) {
          for (const [key, fk] of live) {
            if (fk.table === table || fk.referencedTable === table) live.delete(key);
          }
        }
      }
    }
  }
  return live;
}

/** The recorded, sorted, diff-friendly form written to the baseline fixture. */
export type BaselineEntry = {
  table: string;
  constraint: string;
  columns: string[];
  references: { table: string; columns: string[] };
};

export function toBaseline(fks: Map<string, CompositeTenantFk>): Record<string, BaselineEntry> {
  const out: Record<string, BaselineEntry> = {};
  for (const key of [...fks.keys()].sort()) {
    const fk = fks.get(key)!;
    out[key] = {
      table: fk.table,
      constraint: fk.constraint,
      columns: fk.columns,
      references: { table: fk.referencedTable, columns: fk.referencedColumns },
    };
  }
  return out;
}

/**
 * THE CATALOG QUERY — what PostgreSQL actually has, not what the SQL says.
 *
 * `pg_constraint` is the authority: it is what the planner and the executor read,
 * so a constraint that is not in here is not enforcing anything, whatever the
 * migration text claims. Column names are resolved through `conkey`/`confkey`
 * (attribute NUMBERS) rather than assumed from the constraint's name, because the
 * name is just a string — `Quote_tenantId_revisionOfId_fkey` could be re-added
 * over a single column and would still be named that.
 *
 * `WITH ORDINALITY` preserves the constraint's own column order; `string_agg`
 * rather than `array_agg` because Prisma deserialises text reliably and the
 * caller splits it back.
 *
 * `convalidated` is reported but NOT asserted on. Almost every one of these was
 * added `NOT VALID`, which means historical rows were never re-checked — and
 * that is fine for this guard's purpose: a NOT VALID foreign key still enforces
 * every INSERT and UPDATE from the moment it exists, which is precisely the
 * write path a forged id takes.
 */
export const CATALOG_FK_QUERY = `
  SELECT
    rel.relname AS table_name,
    con.conname AS constraint_name,
    ref.relname AS referenced_table,
    con.convalidated AS validated,
    (SELECT string_agg(att.attname, ',' ORDER BY u.ord)
       FROM unnest(con.conkey) WITH ORDINALITY AS u(attnum, ord)
       JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = u.attnum) AS columns,
    (SELECT string_agg(att.attname, ',' ORDER BY u.ord)
       FROM unnest(con.confkey) WITH ORDINALITY AS u(attnum, ord)
       JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = u.attnum) AS referenced_columns
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_class ref ON ref.oid = con.confrelid
  JOIN pg_namespace ns ON ns.oid = rel.relnamespace
  WHERE con.contype = 'f' AND ns.nspname = 'public'
`;

export type CatalogFk = {
  table: string;
  constraint: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  validated: boolean;
};

export type CatalogRow = {
  table_name: string;
  constraint_name: string;
  referenced_table: string;
  validated: boolean;
  columns: string | null;
  referenced_columns: string | null;
};

export function catalogFromRows(rows: CatalogRow[]): Map<string, CatalogFk> {
  const out = new Map<string, CatalogFk>();
  for (const row of rows) {
    out.set(fkKey(row.table_name, row.constraint_name), {
      table: row.table_name,
      constraint: row.constraint_name,
      columns: (row.columns ?? "").split(",").filter(Boolean),
      referencedTable: row.referenced_table,
      referencedColumns: (row.referenced_columns ?? "").split(",").filter(Boolean),
      validated: row.validated,
    });
  }
  return out;
}

/**
 * Why a recorded constraint is not acceptable in the live catalog. `null` means
 * it is present and the right shape.
 *
 * The shape is checked, not just the name, because the failure this guards
 * against is a migration that RECREATES a relation — Prisma writes
 * `DROP CONSTRAINT … ; ADD CONSTRAINT …` for an altered relation, and the
 * constraint it writes back is the single-column one it knows about. A name-only
 * check would call that a pass.
 */
export function catalogProblem(expected: BaselineEntry, actual: CatalogFk | undefined): string | null {
  if (!actual) return "absent from pg_constraint";
  const columns = actual.columns.join(", ");
  const want = expected.columns.join(", ");
  if (columns !== want) return `columns are (${columns}), recorded as (${want})`;
  if (actual.referencedTable !== expected.references.table) {
    return `references "${actual.referencedTable}", recorded as "${expected.references.table}"`;
  }
  const refColumns = actual.referencedColumns.join(", ");
  const wantRef = expected.references.columns.join(", ");
  if (refColumns !== wantRef) return `references (${refColumns}), recorded as (${wantRef})`;
  return null;
}

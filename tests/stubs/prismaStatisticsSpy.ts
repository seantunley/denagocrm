/**
 * An in-memory stand-in for the four tables the statistics rollup touches, so
 * `rollUpStatistics` can be RUN rather than read.
 *
 * It is not a Prisma emulator. It implements only what the rollup's correctness
 * depends on, and it records every call — which is the entire point, because
 * the central claim of this feature is "running it twice writes nothing the
 * second time" and only the call log can show that. An assertion on the
 * resulting NUMBERS would pass just as happily against a rollup that rewrote
 * every bucket on every tick.
 *
 * Anything the rollup does not use THROWS rather than quietly returning
 * nothing, so a future query shape cannot pass here by being misunderstood.
 *
 * ── the $queryRaw interpreter ───────────────────────────────────────────────
 *
 * The source aggregation is raw SQL (Prisma cannot group by a date expression),
 * so a stub that wanted to run it had two options: hand the rollup a canned
 * answer, or read the SQL it actually built. The first tests nothing — it would
 * pass against a query with no tenant predicate and no soft-delete filter,
 * which are exactly the two mistakes that matter here. So this reads the query:
 * it pulls the table, the bucket column, the truncation unit, the status
 * filter, the dimension and the sum expression back out of the generated SQL
 * and evaluates them against the seeded rows.
 *
 * Every extraction THROWS if its pattern is absent. That makes this a structural
 * guard as well as a test double: delete `WHERE "deletedAt" IS NULL` from the
 * aggregate and the tests do not silently keep passing, they stop running.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type SourceRow = {
  id: string;
  tenantId?: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Immutable lifecycle dates — what the won/lost metrics actually bucket on. */
  wonAt?: Date | null;
  lostAt?: Date | null;
  completedAt?: Date | null;
  deletedAt?: Date | null;
  status?: string;
  source?: string;
  assignedToId?: string | null;
  valueCents?: number;
};

export type Row = Record<string, any> & { id: string };

export type TableName = "Lead" | "JobCard" | "statisticBucket" | "statisticCursor";

export type Call = { model: string; op: string; args: any };

const tables: Record<TableName, Row[]> = {
  Lead: [],
  JobCard: [],
  statisticBucket: [],
  statisticCursor: [],
};

/** Every call made through either client, in order. */
export const calls: Call[] = [];

export function reset(seed: Partial<Record<TableName, Row[]>> = {}) {
  tables.Lead = [...(seed.Lead ?? [])];
  tables.JobCard = [...(seed.JobCard ?? [])];
  tables.statisticBucket = [...(seed.statisticBucket ?? [])];
  tables.statisticCursor = [...(seed.statisticCursor ?? [])];
  calls.length = 0;
}

export function rows(table: TableName): Row[] {
  return tables[table];
}

/** Calls that WROTE — the set that must be empty on an idempotent repeat run. */
export function writes(): Call[] {
  return calls.filter((call) =>
    ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"].includes(
      call.op,
    ),
  );
}

/* ─── matching ────────────────────────────────────────────────────────────── */

function matchesCondition(value: any, condition: any): boolean {
  if (condition === null || condition === undefined) return value === null;
  if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();
  if (typeof condition !== "object") return value === condition;
  for (const [op, operand] of Object.entries(condition)) {
    const left = value instanceof Date ? value.getTime() : value;
    const right = operand instanceof Date ? operand.getTime() : operand;
    switch (op) {
      case "gt": if (!(left > (right as any))) return false; break;
      case "gte": if (!(left >= (right as any))) return false; break;
      case "lt": if (!(left < (right as any))) return false; break;
      case "lte": if (!(left <= (right as any))) return false; break;
      case "in": if (!Array.isArray(operand) || !operand.includes(value)) return false; break;
      case "not":
        if (operand === null) { if (value === null || value === undefined) return false; }
        else if (value === operand) return false;
        break;
      default:
        throw new Error(`prismaStatisticsSpy: unsupported operator "${op}"`);
    }
  }
  return true;
}

function matches(row: Row, where: any = {}): boolean {
  for (const [field, condition] of Object.entries(where ?? {})) {
    if (field === "OR") {
      if (!Array.isArray(condition) || !condition.some((clause) => matches(row, clause))) return false;
      continue;
    }
    // The change probe combines a tenant OR with a keyset OR, which cannot share
    // one object — so it nests both under AND. Every clause must hold.
    if (field === "AND") {
      if (!Array.isArray(condition) || !condition.every((clause) => matches(row, clause))) return false;
      continue;
    }
    if (!matchesCondition(row[field] ?? null, condition)) return false;
  }
  return true;
}

function project(row: Row, select?: Record<string, boolean>): Row {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).map((f) => [f, row[f] ?? null])) as Row;
}

function compare(a: Row, b: Row, orderBy: any): number {
  const clauses = Array.isArray(orderBy) ? orderBy : [orderBy];
  for (const clause of clauses) {
    const entries = Object.entries(clause as Record<string, "asc" | "desc">);
    if (entries.length !== 1) throw new Error("prismaStatisticsSpy: one key per orderBy clause");
    const [field, direction] = entries[0];
    const left = a[field] instanceof Date ? a[field].getTime() : a[field];
    const right = b[field] instanceof Date ? b[field].getTime() : b[field];
    if (left === right) continue;
    const sign = left < right ? -1 : 1;
    return direction === "desc" ? -sign : sign;
  }
  return 0;
}

function model(table: TableName, label: string) {
  return {
    findMany(args: any = {}): Promise<Row[]> {
      calls.push({ model: label, op: "findMany", args });
      let found = tables[table].filter((row) => matches(row, args.where));
      if (args.orderBy) found = [...found].sort((a, b) => compare(a, b, args.orderBy));
      if (args.take !== undefined) found = found.slice(0, args.take);
      return Promise.resolve(found.map((row) => project(row, args.select)));
    },
    findFirst(args: any = {}): Promise<Row | null> {
      calls.push({ model: label, op: "findFirst", args });
      let found = tables[table].filter((row) => matches(row, args.where));
      if (args.orderBy) found = [...found].sort((a, b) => compare(a, b, args.orderBy));
      return Promise.resolve(found.length ? project(found[0], args.select) : null);
    },
    update(args: any): Promise<Row> {
      calls.push({ model: label, op: "update", args });
      const row = tables[table].find((candidate) => matches(candidate, args.where));
      if (!row) throw new Error(`prismaStatisticsSpy: no ${label} matched update`);
      Object.assign(row, args.data);
      return Promise.resolve({ ...row });
    },
    /**
     * The bucket writer uses `updateMany`, not `update`, so the tenant can be
     * NAMED in the predicate alongside the id — `update` accepts only a unique
     * filter. A tenant mismatch therefore matches nothing and writes nothing,
     * which is the behaviour under test rather than an implementation detail.
     */
    updateMany(args: any): Promise<{ count: number }> {
      calls.push({ model: label, op: "updateMany", args });
      const found = tables[table].filter((candidate) => matches(candidate, args.where));
      for (const row of found) Object.assign(row, args.data);
      return Promise.resolve({ count: found.length });
    },
    createMany(args: any): Promise<{ count: number }> {
      calls.push({ model: label, op: "createMany", args });
      const data: Row[] = Array.isArray(args.data) ? args.data : [args.data];
      let count = 0;
      for (const row of data) {
        if (args.skipDuplicates && tables[table].some((existing) => existing.id === row.id)) continue;
        tables[table].push({ ...row });
        count += 1;
      }
      return Promise.resolve({ count });
    },
    upsert(args: any): Promise<Row> {
      calls.push({ model: label, op: "upsert", args });
      const row = tables[table].find((candidate) => matches(candidate, args.where));
      if (row) {
        Object.assign(row, args.update);
        return Promise.resolve({ ...row });
      }
      const created = { ...args.create };
      tables[table].push(created);
      return Promise.resolve({ ...created });
    },
    deleteMany(args: any = {}): Promise<{ count: number }> {
      calls.push({ model: label, op: "deleteMany", args });
      const doomed = new Set(tables[table].filter((row) => matches(row, args.where)));
      tables[table] = tables[table].filter((row) => !doomed.has(row));
      return Promise.resolve({ count: doomed.size });
    },
    groupBy(): Promise<never> {
      throw new Error("prismaStatisticsSpy: groupBy is not implemented");
    },
  };
}

/* ─── the raw aggregate ───────────────────────────────────────────────────── */

const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

/** Truncate to the start of a SAST day or month, independently of the module under test. */
function truncate(unit: "day" | "month", instant: Date): Date {
  const wall = new Date(instant.getTime() + SAST_OFFSET_MS);
  const utc =
    unit === "day"
      ? Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate())
      : Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), 1);
  return new Date(utc - SAST_OFFSET_MS);
}

function extract(sql: string, pattern: RegExp, what: string): RegExpMatchArray {
  const match = sql.match(pattern);
  if (!match) {
    throw new Error(`prismaStatisticsSpy: could not find ${what} in the aggregate SQL:\n${sql}`);
  }
  return match;
}

/**
 * Interpret the rollup's aggregate query against the seeded source rows.
 *
 * Two clauses are load-bearing, and they are handled differently on purpose.
 *
 *   deletedAt IS NULL — REPRODUCED, not required. basePrisma is not a
 *     soft-delete client, so without this clause a trashed lead counts towards
 *     the reported totals for ever. Honouring it here rather than asserting on
 *     it means removing it from the query produces the real symptom — a wrong
 *     number in a bucket — instead of a complaint about missing SQL.
 *
 *   + INTERVAL '2 hours' — REQUIRED. It is the SAST day boundary, and dropping
 *     it files every event between midnight and 02:00 under the previous day.
 *     There is no in-memory equivalent to "reproduce" it against, so it is
 *     asserted structurally.
 */
/**
 * The tenant predicate, REPRODUCED rather than asserted.
 *
 * It must be present in every raw query — the rollup applies it whether or not
 * enforcement is on, which is the whole point — so its absence throws here
 * rather than quietly widening the result set.
 *
 * Two accepted shapes, and the difference between them is the fix:
 *   `("tenantId" = ? OR "tenantId" IS NULL)` — the FOUNDING tenant, which also
 *     owns the legacy un-owned rows.
 *   `"tenantId" = ?`                         — everyone else. STRICT: a second
 *     workspace can never absorb a NULL-tenant row.
 * Either way the bound tenant value is the last one.
 */
function tenantFilter(sql: string, values: any[]): (row: Row) => boolean {
  const foundingForm = /AND \("tenantId" = \?::text OR "tenantId" IS NULL\)/.test(sql);
  const strictForm = /AND "tenantId" = \?::text/.test(sql);
  if (!foundingForm && !strictForm) {
    throw new Error(
      `prismaStatisticsSpy: raw query carries NO tenant predicate — it must always carry one:\n${sql}`,
    );
  }
  const tenantId = values[values.length - 1] as string;
  return (row: Row) => {
    const owner = (row.tenantId ?? null) as string | null;
    return owner === tenantId || (foundingForm && owner === null);
  };
}

/** Rows of `table` this query is allowed to see, with the shared filters applied. */
function visibleRows(sql: string, values: any[], table: TableName): Row[] {
  const excludesTrashed = /"deletedAt" IS NULL/.test(sql);
  const equals = sql.match(/AND "status" = '(\w+)'/);
  const notEquals = sql.match(/AND "status" <> '(\w+)'/);
  const inTenant = tenantFilter(sql, values);
  return tables[table].filter((row) => {
    if (excludesTrashed && row.deletedAt) return false;
    if (equals && row.status !== equals[1]) return false;
    if (notEquals && row.status === notEquals[1]) return false;
    return inTenant(row);
  });
}

/** `SELECT MIN(<col>) AS "oldest"` — the floor of the backfill walk. */
function runOldest(sql: string, values: any[]): any[] {
  const table = extract(sql, /FROM "(Lead|JobCard)"/, 'FROM "<table>"')[1] as TableName;
  const dateColumn = extract(sql, /SELECT MIN\("(\w+)"\)/, "the MIN column")[1];
  const dates = visibleRows(sql, values, table)
    .map((row) => row[dateColumn] as Date | null | undefined)
    .filter((date): date is Date => Boolean(date));
  if (dates.length === 0) return [{ oldest: null }];
  return [{ oldest: dates.reduce((a, b) => (a <= b ? a : b)) }];
}

function runAggregate(sql: string, values: any[]): any[] {
  if (/SELECT MIN\(/.test(sql)) return runOldest(sql, values);

  const table = extract(sql, /FROM "(Lead|JobCard)"/, 'FROM "<table>"')[1] as TableName;
  const unit = extract(sql, /date_trunc\('(day|month)'/, "date_trunc unit")[1] as "day" | "month";
  const dateColumn = extract(sql, /AND "(\w+)" >= \?/, "the bucket date range")[1];

  extract(sql, /\+ INTERVAL '2 hours'\) - INTERVAL '2 hours'/, "the SAST offset arithmetic");

  const [from, to] = values as [Date, Date];

  const dimensionExpr = extract(sql, /\n\s*(.+?) AS "dimension"/, 'the "dimension" expression')[1];
  const sumExpr = extract(sql, /COALESCE\(SUM\((.+?)\), 0\)::bigint/, "the sum expression")[1];

  const dimensionOf = (row: Row): string => {
    if (dimensionExpr === "''") return "";
    const column = extract(
      dimensionExpr,
      /"(\w+)"/,
      `a column in the dimension expression ${dimensionExpr}`,
    )[1];
    return (row[column] as string | null) ?? "";
  };
  const sumOf = (row: Row): number => {
    if (sumExpr === "0") return 0;
    const column = extract(sumExpr, /"(\w+)"/, `a column in the sum expression ${sumExpr}`)[1];
    return Number(row[column] ?? 0);
  };

  const grouped = new Map<string, { bucketStart: Date; dimension: string; count: number; sumCents: bigint }>();
  for (const row of visibleRows(sql, values, table)) {
    const at = row[dateColumn] as Date | null | undefined;
    // A NULL bucket date is outside every range — the row is not counted at all.
    if (!at) continue;
    if (!(at >= from && at < to)) continue;

    const bucketStart = truncate(unit, at);
    const dimension = dimensionOf(row);
    const key = `${bucketStart.toISOString()}|${dimension}`;
    const current =
      grouped.get(key) ?? { bucketStart, dimension, count: 0, sumCents: BigInt(0) };
    current.count += 1;
    current.sumCents += BigInt(sumOf(row));
    grouped.set(key, current);
  }
  return [...grouped.values()];
}

/* ─── the two clients ─────────────────────────────────────────────────────── */

export const prisma = {
  statisticBucket: model("statisticBucket", "statisticBucket"),
  statisticCursor: model("statisticCursor", "statisticCursor"),
};

export const basePrisma = {
  lead: model("Lead", "lead"),
  jobCard: model("JobCard", "jobCard"),
  $queryRaw(query: any): Promise<any[]> {
    // Prisma's Sql exposes `.sql` (placeholders as `?`) and `.values`.
    const text: string = query?.sql ?? String(query);
    const values: any[] = query?.values ?? [];
    calls.push({ model: "$queryRaw", op: "aggregate", args: { text, values } });
    return Promise.resolve(runAggregate(text, values));
  },
};

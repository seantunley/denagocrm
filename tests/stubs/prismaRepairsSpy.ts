/**
 * An in-memory stand-in for the handful of Prisma models Repairs touches, so the
 * reconciliation engine and the detectors can be RUN rather than read.
 *
 * It is not a Prisma emulator. It implements only the query shapes those two
 * modules actually issue — equality and `in`/`gte` filters, `select`, `take`,
 * `orderBy`, `count`, a one-key `groupBy`, and an `upsert` on the compound
 * `(tenantId, key)` selector — and it records every call, so a test can assert
 * how many queries the empty case cost. That count is the whole subject of the
 * cost guard: a sweep that runs per tenant per tick is not wrong in its result
 * when it is wasteful, only in what it costs, and nothing but the calls
 * themselves can show that.
 *
 * Anything not used THROWS rather than quietly returning nothing, so a future
 * query shape cannot pass here by being silently misunderstood.
 */

export type Row = Record<string, unknown> & { id?: string };

export type ModelName =
  | "repairIssue"
  | "journey"
  | "journeyVersion"
  | "emailTemplate"
  | "journeyRun"
  | "tenantIntegrationCredential";

type Where = Record<string, unknown>;
export type Call = { model: ModelName; op: string; args: Record<string, unknown> };

const EMPTY: Record<ModelName, Row[]> = {
  repairIssue: [],
  journey: [],
  journeyVersion: [],
  emailTemplate: [],
  journeyRun: [],
  tenantIntegrationCredential: [],
};

const tables: Record<ModelName, Row[]> = { ...EMPTY };

/** Every call made through this client, in order. */
export const calls: Call[] = [];

let sequence = 0;

export function reset(seed: Partial<Record<ModelName, Row[]>> = {}) {
  for (const name of Object.keys(EMPTY) as ModelName[]) {
    tables[name] = [...(seed[name] ?? [])];
  }
  calls.length = 0;
  sequence = 0;
}

/** The rows still present in a table, for "what survived" assertions. */
export function rows(model: ModelName): Row[] {
  return tables[model];
}

function matches(row: Row, where: Where = {}): boolean {
  for (const [field, condition] of Object.entries(where)) {
    const value = row[field];
    if (condition === null || typeof condition !== "object" || condition instanceof Date) {
      if (field === "resolvedAt" && condition === null) {
        if (value !== null && value !== undefined) return false;
        continue;
      }
      if (value !== condition) return false;
      continue;
    }
    for (const [op, operand] of Object.entries(condition as Record<string, unknown>)) {
      if (op === "in") {
        if (!Array.isArray(operand) || !operand.includes(value)) return false;
      } else if (op === "gte") {
        if (!(value instanceof Date) || !(operand instanceof Date) || !(value >= operand)) return false;
      } else if (op === "not") {
        if (value === operand) return false;
      } else {
        throw new Error(`prismaRepairsSpy: unsupported operator "${op}" on "${field}"`);
      }
    }
  }
  return true;
}

function project(row: Row, select?: Record<string, boolean>): Row {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).map((field) => [field, row[field] ?? null]));
}

function model(name: ModelName) {
  const record = (op: string, args: Record<string, unknown>) => calls.push({ model: name, op, args });

  return {
    findMany(args: Record<string, unknown> = {}): Promise<Row[]> {
      record("findMany", args);
      let found = tables[name].filter((row) => matches(row, args.where as Where));
      const orderBy = args.orderBy as Record<string, "asc" | "desc"> | undefined;
      if (orderBy) {
        const entries = Object.entries(orderBy);
        if (entries.length !== 1) throw new Error("prismaRepairsSpy: one orderBy key only");
        const [field, direction] = entries[0];
        found = [...found].sort((a, b) => {
          const left = a[field] instanceof Date ? (a[field] as Date).getTime() : String(a[field] ?? "");
          const right = b[field] instanceof Date ? (b[field] as Date).getTime() : String(b[field] ?? "");
          const cmp = left < right ? -1 : left > right ? 1 : 0;
          return direction === "desc" ? -cmp : cmp;
        });
      }
      // CURSOR PAGINATION, modelled properly rather than ignored. The journey
      // walk pages with `cursor`/`skip`, and a stub that dropped them would hand
      // page one back on every iteration — a >PAGE_SIZE test would then "pass"
      // while silently re-reading the same rows, which is precisely the class of
      // bug the pagination exists to prevent.
      const cursor = args.cursor as Record<string, unknown> | undefined;
      if (cursor) {
        const entries = Object.entries(cursor);
        if (entries.length !== 1) throw new Error("prismaRepairsSpy: one cursor key only");
        const [field, value] = entries[0];
        const at = found.findIndex((row) => row[field] === value);
        if (at < 0) throw new Error(`prismaRepairsSpy: cursor ${field}=${String(value)} matched no row`);
        found = found.slice(at + (typeof args.skip === "number" ? args.skip : 0));
      }
      if (typeof args.take === "number") found = found.slice(0, args.take);
      return Promise.resolve(found.map((row) => project(row, args.select as Record<string, boolean>)));
    },

    count(args: Record<string, unknown> = {}): Promise<number> {
      record("count", args);
      return Promise.resolve(tables[name].filter((row) => matches(row, args.where as Where)).length);
    },

    groupBy(args: Record<string, unknown> = {}): Promise<Array<Row & { _count: { _all: number } }>> {
      record("groupBy", args);
      const by = args.by as string[];
      if (!Array.isArray(by) || by.length !== 1) throw new Error("prismaRepairsSpy: one groupBy key only");
      const [field] = by;
      const counts = new Map<unknown, number>();
      for (const row of tables[name].filter((r) => matches(r, args.where as Where))) {
        counts.set(row[field], (counts.get(row[field]) ?? 0) + 1);
      }
      return Promise.resolve(
        [...counts].map(([value, count]) => ({ [field]: value, _count: { _all: count } })) as Array<
          Row & { _count: { _all: number } }
        >,
      );
    },

    update(args: Record<string, unknown> = {}): Promise<Row> {
      record("update", args);
      const target = tables[name].find((row) => matches(row, args.where as Where));
      if (!target) throw new Error(`prismaRepairsSpy: ${name}.update matched no row`);
      Object.assign(target, args.data as Row);
      return Promise.resolve({ ...target });
    },

    updateMany(args: Record<string, unknown> = {}): Promise<{ count: number }> {
      record("updateMany", args);
      const targets = tables[name].filter((row) => matches(row, args.where as Where));
      for (const row of targets) Object.assign(row, args.data as Row);
      return Promise.resolve({ count: targets.length });
    },

    upsert(args: Record<string, unknown> = {}): Promise<Row> {
      record("upsert", args);
      const where = args.where as Record<string, unknown>;
      const compound = where.tenantId_key as { tenantId: string; key: string } | undefined;
      if (!compound) throw new Error("prismaRepairsSpy: upsert expects the tenantId_key selector");
      const existing = tables[name].find(
        (row) => row.tenantId === compound.tenantId && row.key === compound.key,
      );
      if (existing) {
        Object.assign(existing, args.update as Row);
        return Promise.resolve({ ...existing });
      }
      // A nullable column a `create` does not mention is NULL, not absent. The
      // difference matters here: `resolvedAt` is how every test tells an open
      // issue from a cleared one, and `undefined` would quietly answer neither.
      const created: Row = {
        id: `row-${++sequence}`,
        resolvedAt: null,
        ignoredAt: null,
        ignoredById: null,
        fixRoute: null,
        ...(args.create as Row),
      };
      tables[name].push(created);
      return Promise.resolve({ ...created });
    },

    findUnique(): never {
      throw new Error(`prismaRepairsSpy: ${name}.findUnique is not implemented`);
    },
  };
}

export const prisma = {
  repairIssue: model("repairIssue"),
  journey: model("journey"),
  journeyVersion: model("journeyVersion"),
  emailTemplate: model("emailTemplate"),
  journeyRun: model("journeyRun"),
  tenantIntegrationCredential: model("tenantIntegrationCredential"),
};

/** The detectors read tenant integration credentials through the BYPASS client. */
export const basePrisma = prisma;

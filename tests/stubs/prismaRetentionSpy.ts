/**
 * A tiny in-memory stand-in for the two Prisma models the retention sweep uses,
 * so `pruneJourneyTraces` can be RUN rather than read.
 *
 * It is not a Prisma emulator. It implements only what the sweep's correctness
 * depends on — the `where` filter, `orderBy`, `take`, `select`, and deleting by
 * a list of ids — and it records every call, so a test can assert how many rows
 * a single delete statement was pointed at. That count is the entire subject of
 * the bounded-sweep guard: an unbounded `deleteMany` is not wrong in its result,
 * only in how much it locks and for how long, and nothing but the call itself
 * can show that.
 *
 * Anything the sweep does not use THROWS rather than quietly returning nothing,
 * so a future query shape cannot pass here by being silently misunderstood.
 */

export type Row = { id: string; createdAt: Date } & Record<string, unknown>;
export type ModelName = "journeyEvent" | "journeyRun";

type Condition = { lt?: Date; in?: unknown[] };
type Where = Record<string, unknown>;
type FindArgs = {
  where?: Where;
  orderBy?: Record<string, "asc" | "desc">;
  take?: number;
  select?: Record<string, boolean>;
};
type DeleteArgs = { where?: Where };

export type Call =
  | { model: ModelName; op: "findMany"; args: FindArgs }
  | { model: ModelName; op: "deleteMany"; args: DeleteArgs };

const tables: Record<ModelName, Row[]> = { journeyEvent: [], journeyRun: [] };

/** Every call made through this client, in order. */
export const calls: Call[] = [];

export function reset(seed: Partial<Record<ModelName, Row[]>> = {}) {
  tables.journeyEvent = [...(seed.journeyEvent ?? [])];
  tables.journeyRun = [...(seed.journeyRun ?? [])];
  calls.length = 0;
}

/** The rows still present in a table, for "what survived" assertions. */
export function rows(model: ModelName): Row[] {
  return tables[model];
}

function matches(row: Row, where: Where = {}): boolean {
  for (const [field, condition] of Object.entries(where)) {
    const value = row[field];
    if (condition === null || typeof condition !== "object" || condition instanceof Date) {
      if (value !== condition) return false;
      continue;
    }
    for (const [op, operand] of Object.entries(condition as Condition)) {
      if (op === "lt") {
        if (!(value instanceof Date) || !(operand instanceof Date) || !(value < operand)) return false;
      } else if (op === "in") {
        if (!Array.isArray(operand) || !operand.includes(value)) return false;
      } else {
        throw new Error(`prismaRetentionSpy: unsupported operator "${op}" on "${field}"`);
      }
    }
  }
  return true;
}

function project(row: Row, select?: Record<string, boolean>): Row {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).map((field) => [field, row[field]])) as Row;
}

function model(name: ModelName) {
  return {
    findMany(args: FindArgs = {}): Promise<Row[]> {
      calls.push({ model: name, op: "findMany", args });
      let found = tables[name].filter((row) => matches(row, args.where));
      if (args.orderBy) {
        const entries = Object.entries(args.orderBy);
        if (entries.length !== 1) throw new Error("prismaRetentionSpy: one orderBy key only");
        const [field, direction] = entries[0];
        // Array.prototype.sort is stable, so equal keys keep insertion order —
        // the same tie-break an index scan gives rows written in sequence.
        found = [...found].sort((a, b) => {
          const left = Number(a[field]);
          const right = Number(b[field]);
          return direction === "desc" ? right - left : left - right;
        });
      }
      if (args.take !== undefined) found = found.slice(0, args.take);
      return Promise.resolve(found.map((row) => project(row, args.select)));
    },
    deleteMany(args: DeleteArgs = {}): Promise<{ count: number }> {
      calls.push({ model: name, op: "deleteMany", args });
      const doomed = new Set(tables[name].filter((row) => matches(row, args.where)));
      tables[name] = tables[name].filter((row) => !doomed.has(row));
      return Promise.resolve({ count: doomed.size });
    },
  };
}

export const prisma = {
  journeyEvent: model("journeyEvent"),
  journeyRun: model("journeyRun"),
};

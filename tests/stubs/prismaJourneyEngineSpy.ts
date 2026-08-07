/**
 * A tiny in-memory stand-in for the models the journey engine's scheduling sweep
 * and event pass touch, so `runScheduledJourneyEnrollments` and
 * `processJourneyEvents` can be RUN rather than read.
 *
 * It is not a Prisma emulator, and deliberately not a tenant guard either — that
 * is the entire point. The db.ts extension only scopes anything when
 * `tenantEnforcing()` is true, so a test running against the real guard would
 * prove nothing about the mode this fix exists for. This client applies exactly
 * the `where` the caller wrote and nothing else, so a query that forgets its own
 * `tenantId` predicate returns every tenant's rows here, just as it does against
 * Postgres with enforcement off.
 *
 * Every call is recorded with its args, so a test can assert on the PREDICATE a
 * sweep sent — not merely on the rows it happened to get back. A query can
 * return the right answer for the wrong reason (one tenant in the fixture, a
 * lucky ordering); only the `where` itself shows the scoping.
 *
 * Anything the engine does not use THROWS rather than quietly returning nothing,
 * so a future query shape cannot pass here by being silently misunderstood.
 */

export type Row = Record<string, unknown> & { id: string };

export const MODELS = [
  "journey",
  "journeyVersion",
  "journeyEvent",
  "lead",
  "contact",
  "segment",
  "vehicle",
  "serviceRecord",
  "communication",
] as const;
export type ModelName = (typeof MODELS)[number];

type Where = Record<string, unknown>;
type Args = {
  where?: Where;
  select?: Record<string, boolean>;
  include?: Record<string, unknown>;
  orderBy?: Record<string, "asc" | "desc">;
  take?: number;
  data?: Record<string, unknown>;
};

export type Call = { model: ModelName; op: string; args: Args };

/**
 * The relations the engine reads through `include`. Nested reads are the ones
 * the Prisma extension can never scope — it only intercepts the TOP-LEVEL
 * operation — so they have to be reachable here or the tests could not tell a
 * scoped `include` from an unscoped one.
 */
const RELATIONS: Record<string, { model: ModelName; fk?: string; localKey?: string; list: boolean }> = {
  "journey.versions": { model: "journeyVersion", fk: "journeyId", list: true },
  "vehicle.serviceRecords": { model: "serviceRecord", fk: "vehicleId", list: true },
  "vehicle.contact": { model: "contact", localKey: "contactId", list: false },
  "contact.communications": { model: "communication", fk: "contactId", list: true },
};

const tables = new Map<ModelName, Row[]>();

/** Every call made through this client, in order. */
export const calls: Call[] = [];

let idSeq = 0;

export function reset(seed: Partial<Record<ModelName, Row[]>> = {}) {
  for (const model of MODELS) tables.set(model, [...(seed[model] ?? [])]);
  calls.length = 0;
  idSeq = 0;
}

/** The rows still present in a table, for "what survived / what was written" assertions. */
export function rows(model: ModelName): Row[] {
  return tables.get(model) ?? [];
}

/** Every recorded call for one model+op — the predicate log a scoping test reads. */
export function callsFor(model: ModelName, op: string): Call[] {
  return calls.filter((call) => call.model === model && call.op === op);
}

function matchesCondition(value: unknown, condition: unknown, field: string): boolean {
  if (condition === null || typeof condition !== "object" || condition instanceof Date) {
    return value === condition || (value instanceof Date && condition instanceof Date && +value === +condition);
  }
  for (const [op, operand] of Object.entries(condition as Record<string, unknown>)) {
    switch (op) {
      case "lt":
        if (!(Number(value) < Number(operand))) return false;
        break;
      case "lte":
        if (!(Number(value) <= Number(operand))) return false;
        break;
      case "gt":
        if (!(Number(value) > Number(operand))) return false;
        break;
      case "gte":
        if (!(Number(value) >= Number(operand))) return false;
        break;
      case "in":
        if (!Array.isArray(operand) || !operand.includes(value)) return false;
        break;
      case "not":
        if (matchesCondition(value, operand, field)) return false;
        break;
      default:
        throw new Error(`prismaJourneyEngineSpy: unsupported operator "${op}" on "${field}"`);
    }
  }
  return true;
}

function matches(row: Row, where: Where = {}): boolean {
  for (const [field, condition] of Object.entries(where)) {
    if (condition === undefined) continue;
    if (!matchesCondition(row[field], condition, field)) return false;
  }
  return true;
}

function order(found: Row[], orderBy?: Record<string, "asc" | "desc">): Row[] {
  if (!orderBy) return found;
  const entries = Object.entries(orderBy);
  if (entries.length !== 1) throw new Error("prismaJourneyEngineSpy: one orderBy key only");
  const [field, direction] = entries[0];
  return [...found].sort((a, b) => {
    const left = Number(a[field]);
    const right = Number(b[field]);
    return direction === "desc" ? right - left : left - right;
  });
}

function hydrate(model: ModelName, row: Row, args: Args): Row {
  let shaped: Row = args.select
    ? (Object.fromEntries(Object.keys(args.select).map((f) => [f, row[f]])) as Row)
    : { ...row };
  for (const [name, spec] of Object.entries(args.include ?? {})) {
    const relation = RELATIONS[`${model}.${name}`];
    if (!relation) throw new Error(`prismaJourneyEngineSpy: unknown relation "${model}.${name}"`);
    const nested: Args = spec && typeof spec === "object" ? (spec as Args) : {};
    const pool = rows(relation.model).filter((child) =>
      relation.fk ? child[relation.fk] === row.id : child.id === row[relation.localKey!],
    );
    // The nested `where` is applied exactly as written, same as the top level —
    // an `include` that forgets its tenant predicate must show up as a leak.
    const kept = pool.filter((child) => matches(child, nested.where));
    const hydrated = order(kept, nested.orderBy)
      .slice(0, nested.take ?? Infinity)
      .map((child) => hydrate(relation.model, child, nested));
    shaped = { ...shaped, [name]: relation.list ? hydrated : (hydrated[0] ?? null) };
  }
  return shaped;
}

function applyData(row: Row, data: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(data)) {
    if (value && typeof value === "object" && !Array.isArray(value) && "increment" in value) {
      row[field] = Number(row[field] ?? 0) + Number((value as { increment: number }).increment);
    } else {
      row[field] = value;
    }
  }
}

function model(name: ModelName) {
  const find = (args: Args) => {
    const kept = rows(name).filter((row) => matches(row, args.where));
    return order(kept, args.orderBy).slice(0, args.take ?? Infinity);
  };
  return {
    findMany(args: Args = {}) {
      calls.push({ model: name, op: "findMany", args });
      return Promise.resolve(find(args).map((row) => hydrate(name, row, args)));
    },
    findFirst(args: Args = {}) {
      calls.push({ model: name, op: "findFirst", args });
      const [row] = find(args);
      return Promise.resolve(row ? hydrate(name, row, args) : null);
    },
    findUnique(args: Args = {}) {
      calls.push({ model: name, op: "findUnique", args });
      const [row] = find(args);
      return Promise.resolve(row ? hydrate(name, row, args) : null);
    },
    create(args: Args = {}) {
      calls.push({ model: name, op: "create", args });
      const row = { id: `${name}-${++idSeq}`, createdAt: new Date(), ...(args.data ?? {}) } as Row;
      rows(name).push(row);
      return Promise.resolve({ ...row });
    },
    update(args: Args = {}) {
      calls.push({ model: name, op: "update", args });
      const [row] = find(args);
      // Prisma raises P2025 when an extended-unique `where` matches nothing —
      // which, once tenantId is part of that where, is exactly what a foreign
      // row must do. Silently updating zero rows would hide that.
      if (!row) throw new Error(`prismaJourneyEngineSpy: no ${name} matched update where`);
      applyData(row, args.data ?? {});
      return Promise.resolve({ ...row });
    },
    updateMany(args: Args = {}) {
      calls.push({ model: name, op: "updateMany", args });
      const found = find(args);
      for (const row of found) applyData(row, args.data ?? {});
      return Promise.resolve({ count: found.length });
    },
  };
}

export const prisma = Object.fromEntries(MODELS.map((name) => [name, model(name)])) as Record<
  ModelName,
  ReturnType<typeof model>
>;

reset();

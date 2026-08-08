/**
 * A tiny in-memory stand-in for the eight Prisma models the fleet roll-up reads,
 * so `loadFleetRollup` can be RUN rather than read.
 *
 * WHY THIS EXISTS AT ALL. The question worth answering about the fleet page is
 * "does another tenant's data appear on it", and a source-grep for
 * `...tenant` cannot answer it: the predicate can be present and spread into the
 * wrong object, present on seven queries and missing from the eighth, or shadowed
 * by a later key. Only running the real function against rows belonging to two
 * different tenants settles it.
 *
 * THE ONE RULE THAT MAKES IT A TEST. This client applies NO tenant scoping of its
 * own. It filters on exactly what the `where` it is handed says, and nothing
 * more. So if `loadFleetRollup` ever stops naming the tenant, the second tenant's
 * rows come straight back and the assertions fail. A stub that helpfully scoped
 * by tenant would pass whether or not the code under test did its job — which is
 * the failure mode of most hand-written database fakes.
 *
 * It is not a Prisma emulator. It implements only what the roll-up's correctness
 * depends on — equality and `in` matching in `where`, `select` projection,
 * `orderBy`, and `take` — and it records every call so a test can assert that a
 * query was never made at all. Anything the roll-up does not use THROWS rather
 * than quietly returning nothing, so a future query shape cannot pass here by
 * being silently misunderstood.
 */

export type Row = Record<string, unknown> & { id: string };

export type ModelName =
  | "contact"
  | "activity"
  | "lead"
  | "communication"
  | "researchNote"
  | "referral"
  | "document"
  | "consentRecord"
  | "quote";

export const MODELS: ModelName[] = [
  "contact",
  "activity",
  "lead",
  "communication",
  "researchNote",
  "referral",
  "document",
  "consentRecord",
  "quote",
];

type Where = Record<string, unknown>;
type OrderBy = Record<string, "asc" | "desc">;
type FindArgs = {
  where?: Where;
  select?: Record<string, unknown>;
  orderBy?: OrderBy | OrderBy[];
  take?: number;
};

export type Call = { model: ModelName; args: FindArgs };

const tables = Object.fromEntries(MODELS.map((m) => [m, [] as Row[]])) as Record<ModelName, Row[]>;

/** Every query made through this client, in order. */
export const calls: Call[] = [];

export function reset(seed: Partial<Record<ModelName, Row[]>> = {}): void {
  for (const model of MODELS) tables[model] = [...(seed[model] ?? [])];
  calls.length = 0;
}

/** The `where` of every call made against one model. */
export function wheres(model: ModelName): Where[] {
  return calls.filter((call) => call.model === model).map((call) => call.args.where ?? {});
}

function matches(row: Row, where: Where = {}): boolean {
  for (const [field, condition] of Object.entries(where)) {
    // `OR` is a list of alternative where-clauses, not a column. The quotes
    // roll-up needs it: a quote belongs to a fleet's page either because it is
    // BILLED to the fleet or because it belongs to one of its members, and those
    // are different columns. Everything outside the OR still has to match, so
    // the tenant predicate cannot be satisfied by an OR arm.
    if (field === "OR") {
      if (!Array.isArray(condition)) {
        throw new Error("fleetRollupSpy: OR must be an array of where-clauses");
      }
      if (!condition.some((clause) => matches(row, clause as Where))) return false;
      continue;
    }
    const value = row[field];
    // `deletedAt: null` and `tenantId: "t1"` are plain equality. Dates compare by
    // instant, not by identity, so two equal Dates match.
    if (condition === null || typeof condition !== "object") {
      if (value instanceof Date && condition instanceof Date) {
        if (value.getTime() !== (condition as Date).getTime()) return false;
        continue;
      }
      if (value !== condition) return false;
      continue;
    }
    if (condition instanceof Date) {
      if (!(value instanceof Date) || value.getTime() !== condition.getTime()) return false;
      continue;
    }
    const entries = Object.entries(condition as Record<string, unknown>);
    if (entries.length !== 1 || entries[0][0] !== "in") {
      throw new Error(
        `fleetRollupSpy: unsupported condition on "${field}": ${JSON.stringify(condition)}`,
      );
    }
    const operand = entries[0][1];
    if (!Array.isArray(operand) || !operand.includes(value)) return false;
  }
  return true;
}

/**
 * Project a row through `select`.
 *
 * A nested `{ select: … }` (the relation includes: owner, assignedTo, stage,
 * user, uploadedBy, lead, contact) returns the seeded object as-is. Resolving
 * relations properly would make this a database; the roll-up's correctness does
 * not turn on relation shape, only on which ROWS come back.
 *
 * A selected field the row does not carry is an ERROR, not `undefined`: a typo in
 * a `select` would otherwise surface as a silently blank column on the page.
 */
function project(row: Row, select?: Record<string, unknown>): Row {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const field of Object.keys(select)) {
    if (!(field in row)) {
      throw new Error(`fleetRollupSpy: selected "${field}" is not on the seeded row ${row.id}`);
    }
    out[field] = row[field];
  }
  return out as Row;
}

function compare(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a ?? "").localeCompare(String(b ?? ""));
}

function sort(rows: Row[], orderBy?: OrderBy | OrderBy[]): Row[] {
  if (!orderBy) return rows;
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((clause) =>
    Object.entries(clause),
  );
  // Array.prototype.sort is stable, so equal keys keep insertion order.
  return [...rows].sort((left, right) => {
    for (const [field, direction] of keys) {
      const result = compare(left[field], right[field]);
      if (result !== 0) return direction === "desc" ? -result : result;
    }
    return 0;
  });
}

function model(name: ModelName) {
  return {
    findMany(args: FindArgs = {}): Promise<Row[]> {
      calls.push({ model: name, args });
      let found = tables[name].filter((row) => matches(row, args.where));
      found = sort(found, args.orderBy);
      if (args.take !== undefined) found = found.slice(0, args.take);
      return Promise.resolve(found.map((row) => project(row, args.select)));
    },
  };
}

export const prisma = Object.fromEntries(MODELS.map((m) => [m, model(m)])) as Record<
  ModelName,
  ReturnType<typeof model>
>;

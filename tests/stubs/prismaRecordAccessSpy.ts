/**
 * An in-memory stand-in for the handful of `basePrisma` reads the record-access
 * helpers in `lib/permissions.ts` make, so `canAccessLead` and its six siblings
 * can be RUN against two tenants rather than read.
 *
 * It is not a Prisma emulator. It splits sharply in two, and the split is the
 * whole point:
 *
 *   - `findFirst` is IMPLEMENTED. It matches `id` and `tenantId` exactly, because
 *     that lookup IS the fix under test. `tenantId` absent from the `where` means
 *     "no tenant filter" — the not-enforcing case — and is a different fact from
 *     `tenantId: null`, which filters on the legacy untenanted value. Collapsing
 *     those two is the regression `tenantPredicate.ts` exists to prevent, so the
 *     fake must be able to tell them apart.
 *
 *   - `findMany` and `$queryRaw` are DELIBERATELY MAXIMALLY PERMISSIVE: they
 *     ignore the `where` and return every seeded row, in EVERY tenant. Those are
 *     the queries behind `getAccessible*Ids`, and stubbing them this way makes the
 *     accessible-id list answer "yes" to every id in the fixture — including the
 *     other tenant's. So nothing but the tenant predicate can produce a refusal,
 *     and a test that sees one has tested exactly that predicate and nothing else.
 *     A fake that returned `[]` here would make every helper refuse and every
 *     assertion pass vacuously.
 *
 * Anything else THROWS rather than quietly returning nothing, so a future query
 * shape cannot pass here by being silently misunderstood.
 */

export type Row = { id: string; tenantId: string | null } & Record<string, unknown>;

export type ModelName =
  | "lead"
  | "contact"
  | "quote"
  | "vehicle"
  | "jobCard"
  | "document"
  | "customerCase";

const MODELS: ModelName[] = [
  "lead",
  "contact",
  "quote",
  "vehicle",
  "jobCard",
  "document",
  "customerCase",
];

type Where = Record<string, unknown>;
type FindArgs = { where?: Where; select?: Record<string, boolean> };

export type Call =
  | { model: ModelName; op: "findFirst"; args: FindArgs }
  | { model: ModelName; op: "findMany"; args: FindArgs }
  | { model: "raw"; op: "queryRaw"; args: { sql: string } };

const tables = Object.fromEntries(MODELS.map((m) => [m, [] as Row[]])) as Record<ModelName, Row[]>;

/** Every call made through this client, in order. */
export const calls: Call[] = [];

export function reset(seed: Partial<Record<ModelName, Row[]>> = {}) {
  for (const model of MODELS) tables[model] = [...(seed[model] ?? [])];
  calls.length = 0;
}

/** The rows seeded into a table, for "what did the list see" assertions. */
export function rows(model: ModelName): Row[] {
  return tables[model];
}

/**
 * Exact-match only. A `where` operator object (`in`, `not`, …) means the helper
 * asked something this fake was never told how to answer, and guessing is how a
 * security test passes while the code is wrong.
 */
function matches(row: Row, where: Where = {}): boolean {
  for (const [field, condition] of Object.entries(where)) {
    if (condition !== null && typeof condition === "object") {
      throw new Error(`prismaRecordAccessSpy: unsupported condition on "${field}"`);
    }
    if (row[field] !== condition) return false;
  }
  return true;
}

function project(row: Row, select?: Record<string, boolean>): Row {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).map((f) => [f, row[f]])) as Row;
}

function model(name: ModelName) {
  return {
    findFirst(args: FindArgs = {}): Promise<Row | null> {
      calls.push({ model: name, op: "findFirst", args });
      const found = tables[name].find((row) => matches(row, args.where));
      return Promise.resolve(found ? project(found, args.select) : null);
    },
    findMany(args: FindArgs = {}): Promise<Row[]> {
      // The `where` is ignored on purpose — see the header. This is the
      // accessible-id list, and it is rigged to say yes to everything.
      calls.push({ model: name, op: "findMany", args });
      return Promise.resolve(tables[name].map((row) => project(row, args.select)));
    },
  };
}

/**
 * `getAccessibleLeadIds` and `getAccessibleCaseIds` are raw SQL (Lead.teamId is
 * not on the Prisma model; the case query needs `= ANY(…)`), so they arrive here
 * as a tagged template. Route by the table named in the statement and, as with
 * `findMany`, hand back every row in every tenant.
 */
function queryRaw(strings: TemplateStringsArray | string[], ..._values: unknown[]): Promise<Array<{ id: string }>> {
  const sql = Array.from(strings).join(" ");
  calls.push({ model: "raw", op: "queryRaw", args: { sql } });
  if (/FROM "Lead"/.test(sql)) return Promise.resolve(tables.lead.map((row) => ({ id: row.id })));
  if (/FROM "CustomerCase"/.test(sql)) return Promise.resolve(tables.customerCase.map((row) => ({ id: row.id })));
  throw new Error(`prismaRecordAccessSpy: unexpected raw query: ${sql.replace(/\s+/g, " ").trim().slice(0, 120)}`);
}

export const basePrisma = {
  lead: model("lead"),
  contact: model("contact"),
  quote: model("quote"),
  vehicle: model("vehicle"),
  jobCard: model("jobCard"),
  document: model("document"),
  customerCase: model("customerCase"),
  $queryRaw: queryRaw,
};

/* ------------------------------------------------------------------------- */

/**
 * A stand-in for `lib/permissionQuery.ts`, whose real implementation is one more
 * `basePrisma.$queryRaw`. The grant set is what decides whether a helper's id
 * list comes back unrestricted (`null`) or scoped, and both branches have to be
 * exercised: the unrestricted one is where the defect was loudest, and the scoped
 * one is where the id-list collision proves the predicate is what refuses.
 */
export const RBAC_UNAVAILABLE = "__rbac_unavailable__";
export const RBAC_INITIALIZED = "__rbac_initialized__";

let granted: string[] = [];

/** The permission keys the next `getUserPermissions()` will report. */
export function setPermissions(keys: string[]): void {
  granted = [...keys];
}

export const permissionQuery = {
  RBAC_UNAVAILABLE,
  RBAC_INITIALIZED,
  getUserPermissions: (): Promise<Set<string>> =>
    Promise.resolve(new Set([RBAC_INITIALIZED, ...granted])),
  usablePermissions: (grants: Set<string>): Set<string> => {
    if (grants.has(RBAC_UNAVAILABLE) || !grants.has(RBAC_INITIALIZED)) return new Set();
    return new Set([...grants].filter((key) => !key.startsWith("__")));
  },
};

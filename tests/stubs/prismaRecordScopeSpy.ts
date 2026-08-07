/**
 * A call recorder standing in for basePrisma, for testing what the record-scope
 * helpers DO NOT do.
 *
 * It is deliberately not an emulator. The question these tests ask is whether a
 * helper short-circuits — whether a user holding no view permission is answered
 * "[] , nothing accessible" without the table ever being read, and whether a
 * *.view_all holder is answered "null, unrestricted" the same way. Both answers
 * are correct only if no query was issued to produce them, so recording the calls
 * IS the assertion; what a query would have returned is beside the point.
 *
 * Every model method records and returns nothing. Anything not listed throws, so
 * a helper that grows a new query cannot pass here by being silently ignored.
 */

export type Call = { model: string; op: string; args: unknown };

export const calls: Call[] = [];

/** Rows the next findMany / $queryRaw hands back, in order. */
let queued: Array<Array<{ id: string }>> = [];

export function reset(rows: Array<Array<{ id: string }>> = []) {
  calls.length = 0;
  queued = [...rows];
}

function next(): Array<{ id: string }> {
  return queued.shift() ?? [];
}

function model(name: string) {
  const record = (op: string) => (args: unknown) => {
    calls.push({ model: name, op, args });
    return Promise.resolve(next());
  };
  return new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === "findMany") return record("findMany");
        if (prop === "findFirst") return record("findFirst");
        if (prop === "then") return undefined; // not a thenable
        throw new Error(`prismaRecordScopeSpy: ${name}.${String(prop)} is not modelled`);
      },
    },
  );
}

export const basePrisma = new Proxy(
  {
    /** Tagged template, as the lead scope uses it. */
    $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
      calls.push({ model: "$queryRaw", op: "tagged", args: { sql: strings.join("?"), values } });
      return Promise.resolve(next());
    },
  } as Record<string, unknown>,
  {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (typeof prop !== "string" || prop.startsWith("$")) return undefined;
      const cached = target[`__${prop}`];
      if (cached) return cached;
      const built = model(prop);
      target[`__${prop}`] = built;
      return built;
    },
  },
);

export const prisma = basePrisma;

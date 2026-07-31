import { Prisma } from "@prisma/client";
import { basePrisma } from "./db";

/**
 * Case-insensitive EXACT matching, for the columns this app uses as identity.
 *
 * WHY THIS EXISTS — Prisma has no safe case-insensitive equality. Writing
 *
 *     where: { email: { equals: value, mode: "insensitive" } }
 *
 * compiles to `"email" ILIKE $1` with `value` bound UNESCAPED. Verified against
 * the production database, which emitted exactly:
 *
 *     SELECT "public"."Contact"."id" FROM "public"."Contact"
 *     WHERE "public"."Contact"."email" ILIKE $1 LIMIT $2 OFFSET $3
 *
 * So `_` and `%` in the caller's string are LIKE wildcards, not literals. On the
 * same database, `equals: "%@%"` with `mode: "insensitive"` returned a real
 * customer contact. Both characters are legal in an email local part, so this is
 * reachable with an address someone can actually register and receive mail at.
 *
 * The consequences differ by call site — a lookup that RESOLVES identity (who is
 * this, which record do I attach this to) can be pointed at someone else's row;
 * a lookup that CHECKS UNIQUENESS can be turned into a prefix oracle for
 * enumerating the table. Neither is acceptable, and the shared cause is the
 * comparison, so the comparison is what this module replaces.
 *
 * WHY NOT ESCAPE THE METACHARACTERS — tested, and the escape does not survive
 * Prisma's ILIKE. Even if it did, escaping is the wrong shape of fix: it has to
 * be remembered at every future call site, and it leaves a pattern match where
 * an equality is meant. Stop using LIKE instead.
 *
 * WHY LOWER()/UPPER() AND NOT A PLAIN `=` — production has a Contact whose stored
 * address is mixed-case (checked: exactly one). A case-sensitive `=` closes the
 * hole and locks that customer out, which is not a fix. The fold is applied to
 * BOTH sides in SQL rather than lowercasing in JS, so the two sides always agree
 * on collation. StockUnit and Vehicle fold with UPPER to match the existing
 * `UNIQUE (upper(serial)) WHERE serial IS NOT NULL AND "deletedAt" IS NULL` index.
 *
 * WHY IT RETURNS IDs RATHER THAN ROWS — the raw statement runs on `basePrisma`,
 * which bypasses RLS and the soft-delete/tenant extension in db.ts. Returning
 * only ids means callers feed them straight back into the ordinary guarded client
 * (`prisma.contact.findFirst({ where: { id: { in: ids } } })`), so soft-delete,
 * tenant scope and RLS are all still applied by the code that already owns them.
 * This resolver can therefore only ever NARROW what a call site sees — it cannot
 * widen access even if a target below is wrong.
 */

const TARGETS = {
  contactEmail: { table: "Contact", column: "email", fold: "lower" },
  leadEmail: { table: "Lead", column: "email", fold: "lower" },
  userEmail: { table: "User", column: "email", fold: "lower" },
  supportMailboxEmail: { table: "SupportMailbox", column: "email", fold: "lower" },
  vehicleVin: { table: "Vehicle", column: "vin", fold: "upper" },
  stockUnitSerial: { table: "StockUnit", column: "serial", fold: "upper" },
} as const;

export type CiExactTarget = keyof typeof TARGETS;

/** Any Prisma handle that can run a raw query — the client, or a `$transaction` tx. */
type RawCapableClient = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * Identifiers can never come from a caller — a target key indexes the frozen map
 * above — but assert the shape anyway so the safety of `Prisma.raw` is visible
 * here rather than only by tracing where TARGETS is built. Covered by a test.
 */
const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

function quoteIdentifier(name: string): string {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`Refusing to interpolate identifier: ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}

/**
 * Ids of every row whose `column` equals `value`, ignoring case and treating the
 * value as a literal. The drop-in replacement for `{ equals, mode: "insensitive" }`.
 *
 * Ordering is deterministic (oldest first, ties broken by id) so that two lookups
 * of the same value in one request can never disagree about which row they mean —
 * an unordered `findFirst` was itself a bug on the portal login path, where the
 * code was mailed against one row and the session minted against another.
 *
 * @param client pass the transaction handle when the caller holds a lock that the
 *   lookup must sit inside — otherwise this runs on its own pooled connection and
 *   the lock does not cover it.
 */
export async function ciExactIds(
  target: CiExactTarget,
  value: string,
  opts: { client?: RawCapableClient; limit?: number } = {},
): Promise<string[]> {
  const { table, column, fold } = TARGETS[target];
  const client = opts.client ?? basePrisma;
  // An exact match is naturally bounded by real duplicates; the cap is only here
  // so a pathological data state can't return an unbounded id list.
  const limit = opts.limit ?? 200;

  const col = Prisma.raw(quoteIdentifier(column));
  // Both branches are literal SQL — the fold name is never interpolated.
  const match =
    fold === "upper"
      ? Prisma.sql`UPPER(${col}) = UPPER(${value})`
      : Prisma.sql`LOWER(${col}) = LOWER(${value})`;

  const rows = await client.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT "id" FROM ${Prisma.raw(quoteIdentifier(table))}
    WHERE ${match}
    ORDER BY "createdAt" ASC, "id" ASC
    LIMIT ${limit}
  `);
  return rows.map((row) => row.id);
}

/**
 * The same lookup as a Prisma `where` fragment, for dropping into an existing
 * query — including inside an `OR`, where the old ILIKE clause usually sat.
 *
 * An empty id list yields `{ id: { in: [] } }`, which matches nothing. That is
 * the correct reading of "no row has this value" and needs no special case, but
 * note it composes by AND with any other `id` constraint in the same object —
 * use `AND: [...]` when the query already constrains `id`.
 */
export async function ciExactIdFilter(
  target: CiExactTarget,
  value: string,
  opts: { client?: RawCapableClient; limit?: number } = {},
): Promise<{ id: { in: string[] } }> {
  return { id: { in: await ciExactIds(target, value, opts) } };
}

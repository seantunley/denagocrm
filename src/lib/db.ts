import { PrismaClient } from "@prisma/client";
import { SOFT_DELETE_MODELS } from "./softDeleteModels";

const globalForPrisma = globalThis as unknown as {
  basePrisma?: PrismaClient;
  prisma?: ReturnType<typeof buildClient>;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
function addAliveFilter(model: string, args: any) {
  if (!SOFT_DELETE_MODELS.has(model)) return args;
  args = args ?? {};
  const where = args.where ?? {};
  // an explicit deletedAt filter (e.g. the Trash page) wins
  if (!("deletedAt" in where)) {
    args.where = { ...where, deletedAt: null };
  }
  return args;
}

/**
 * Mutation guard for soft-delete models. update / delete accept a non-unique
 * `deletedAt` filter alongside their unique key (extendedWhereUnique, GA in
 * Prisma 5+), so injecting `deletedAt: null` makes them match ONLY live rows:
 * update/delete throw P2025 on a trashed row (mutation refused) and
 * updateMany/deleteMany simply skip it. This is what stops a direct action from
 * mutating a record sitting in Trash even for an owner / view_all user whose
 * access isn't tied to an active-ID list.
 *
 * SCOPE — this guards the FILTERED `prisma` client only. It does NOT cover:
 *   - `basePrisma` (raw): Trash / restore / purge use it deliberately, but so do
 *     some business transactions that need row locks (quote saves, part claims).
 *     Those MUST add their own `deletedAt: null` predicate — see quoteLock,
 *     claimPartStock, reservePart, merge. basePrisma is not a soft-delete client.
 *   - `upsert` (would force a spurious create on a trashed unique row) and nested
 *     writes inside another model's `data` (only top-level calls are intercepted).
 * An explicit deletedAt in the where (rare) still wins.
 */
function addAliveMutationFilter(model: string, args: any) {
  return addAliveFilter(model, args);
}

/**
 * findUnique / findUniqueOrThrow can't take a non-unique `deletedAt` filter in
 * their `where`, so the collection filter above doesn't cover them — a trashed
 * record would still resolve from a saved URL or a direct action (findUnique is
 * the most common detail-page/action lookup). Filter on the RESULT instead: if
 * the row is soft-deleted, treat it as absent. When the caller used a `select`
 * that omits deletedAt we transparently add it (so we can test it) and strip it
 * back off, preserving the caller's expected shape. Code that genuinely needs
 * trashed rows uses basePrisma (Trash / restore / purge), which is unfiltered.
 */
async function filteredUnique(
  model: string,
  args: any,
  query: (a: any) => Promise<any>,
  orThrow: boolean,
) {
  if (!SOFT_DELETE_MODELS.has(model)) return query(args);
  const hasSelect = args?.select && typeof args.select === "object";
  // Inject deletedAt whenever the caller's select doesn't already ASK for it
  // (=== true). Testing only for the key's presence let `deletedAt: false` slip
  // through: the key exists, so nothing was injected, and the result then had no
  // deletedAt to test — a trashed row would resolve as if alive.
  const injectDeletedAt = hasSelect && args.select.deletedAt !== true;
  const runArgs = injectDeletedAt
    ? { ...args, select: { ...args.select, deletedAt: true } }
    : args;
  const result = await query(runArgs);
  if (result && result.deletedAt) {
    if (orThrow) throw new Error(`No ${model} found`);
    return null;
  }
  if (result && injectDeletedAt) {
    const { deletedAt: _dropped, ...rest } = result;
    void _dropped;
    return rest;
  }
  return result;
}

function buildClient(base: PrismaClient) {
  return base.$extends({
    query: {
      $allModels: {
        async findMany({ model, args, query }: any) {
          return query(addAliveFilter(model, args));
        },
        async findFirst({ model, args, query }: any) {
          return query(addAliveFilter(model, args));
        },
        async findUnique({ model, args, query }: any) {
          return filteredUnique(model, args, query, false);
        },
        async findUniqueOrThrow({ model, args, query }: any) {
          return filteredUnique(model, args, query, true);
        },
        // Mutations are guarded too, not just reads: a trashed row must not be
        // updatable/deletable through the filtered client (Trash/restore/purge
        // use basePrisma). update/delete throw on a trashed row; the *Many forms
        // skip it. upsert is intentionally NOT guarded (injecting the filter into
        // its unique where would force a spurious create on a trashed row).
        async update({ model, args, query }: any) {
          return query(addAliveMutationFilter(model, args));
        },
        async updateMany({ model, args, query }: any) {
          return query(addAliveMutationFilter(model, args));
        },
        async delete({ model, args, query }: any) {
          return query(addAliveMutationFilter(model, args));
        },
        async deleteMany({ model, args, query }: any) {
          return query(addAliveMutationFilter(model, args));
        },
        async count({ model, args, query }: any) {
          return query(addAliveFilter(model, args));
        },
        async aggregate({ model, args, query }: any) {
          return query(addAliveFilter(model, args));
        },
        async groupBy({ model, args, query }: any) {
          return query(addAliveFilter(model, args));
        },
      },
      // Shared inbox: attach every new message to a conversation and roll its
      // counters/unread forward. Best-effort — conversation bookkeeping must
      // never fail a Communication write. Uses basePrisma internally (no recursion).
      communication: {
        async create({ args, query }: any) {
          let conversationId: string | null = null;
          try {
            const { resolveConversationId } = await import("./conversations");
            conversationId = await resolveConversationId(args.data);
            if (conversationId && !args.data.conversationId) args.data.conversationId = conversationId;
          } catch {
            conversationId = null;
          }
          const result = await query(args);
          if (conversationId) {
            try {
              const { bumpConversation } = await import("./conversations");
              await bumpConversation(conversationId, args.data);
            } catch {
              /* bookkeeping is best-effort */
            }
          }
          return result;
        },
      },
    },
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Raw client WITHOUT the soft-delete filter — for backups, trash, restore, purge,
 * and for business transactions that need row locks / raw SQL. Because it is
 * unfiltered, any business use MUST add its own `deletedAt: null` predicate to
 * avoid reading or mutating trashed rows (see quoteLock, claimPartStock, merge).
 */
export const basePrisma = globalForPrisma.basePrisma ?? new PrismaClient();

/** Default client: soft-deleted records are hidden from list/count queries. */
export const prisma = globalForPrisma.prisma ?? buildClient(basePrisma);

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.basePrisma = basePrisma;
  globalForPrisma.prisma = prisma;
}

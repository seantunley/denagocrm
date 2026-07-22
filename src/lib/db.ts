import { PrismaClient } from "@prisma/client";
import { SOFT_DELETE_MODELS } from "./softDeleteModels";
import { currentTenantScope } from "./tenantScope";
import { tenantEnforcing } from "./tenantEnforcement";
import {
  isTenantScopedModel,
  scopeWhere,
  stampCreate,
  scopeMutation,
  scopeUpsert,
  hasNestedRelationWrite,
  TenantScopeError,
} from "./tenantGuard";

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
 *
 * Tenant scoping for unique reads is handled SEPARATELY and at the DB layer: the
 * findUnique* hooks pass args through `scopeArgs(..., "where")` first, which adds
 * `tenantId` to the `where` (Prisma 6 extendedWhereUnique) so a cross-tenant row
 * is never fetched in the first place — no result-filtering needed here.
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

type ScopeKind = "where" | "create" | "mutation" | "upsert";

/**
 * DORMANT request-scoped tenant guard (Phase C). When `tenantEnforcing()` is
 * false — always, today — this returns `args` untouched, so the extension
 * behaves exactly as it did pre-tenancy. When enforcement is flipped on (per
 * environment, no code change): tenant-scoped models REQUIRE a tenant scope in
 * async context and fail closed without one; a `system` scope bypasses; and args
 * are rewritten to confine the read/write to the caller's tenant.
 *
 * SCOPE / LIMITS — this is DEFENCE-IN-DEPTH, not the authoritative boundary:
 *   - Prisma query extensions only intercept TOP-LEVEL operations, so `tenantId`
 *     is stamped/scoped on the top-level payload only. NESTED relation writes
 *     (`create`/`connect`/`update`/`upsert` inside another model's `data`) can't
 *     be safely stamped here, so under enforcement they are REFUSED (fail closed)
 *     until tenant-aware composite FKs land — they are NOT silently accepted.
 *   - A DIRECT child create that passes a scalar parent FK owned by another tenant
 *     is NOT caught by this guard, and RLS does NOT close it either (a single-column
 *     FK only checks the parent id exists; a row policy only checks the child's own
 *     tenantId). That parent/child consistency requires tenant-aware COMPOSITE FKs
 *     — `(tenantId, parentId) → Parent(tenantId, id)` — added in the FK step. RLS
 *     is the authoritative ROW-level boundary; composite FKs are the authoritative
 *     CROSS-ROW boundary. Both, plus this guard, are needed.
 *   - Therefore enforcement is a HARD-gated staged rollout: `tenantEnforcing()`
 *     must not return true in any environment until RLS + composite FKs are live
 *     (see tenantEnforcement.ts and PHASE-C-TENANT-GUARD-DESIGN.md §1.3/§1.5/§5/§6).
 */
function scopeArgs(model: string, kind: ScopeKind, args: any): any {
  if (!tenantEnforcing()) return args;
  if (!isTenantScopedModel(model)) return args;
  const scope = currentTenantScope();
  if (!scope) throw new TenantScopeError(`No tenant scope established for ${model}`);
  if (scope.system) return args;
  if (!scope.tenantId) throw new TenantScopeError(`No tenant in scope for ${model}`);
  switch (kind) {
    case "where":
      return scopeWhere(args, scope.tenantId);
    case "create":
      refuseNestedRelationWrite(model, args?.data);
      return stampCreate(args, scope.tenantId);
    case "mutation":
      refuseNestedRelationWrite(model, args?.data);
      return scopeMutation(args, scope.tenantId);
    case "upsert":
      refuseNestedRelationWrite(model, args?.create);
      refuseNestedRelationWrite(model, args?.update);
      return scopeUpsert(args, scope.tenantId);
  }
}

/**
 * Nested relation writes can't be tenant-stamped/validated by a query extension
 * (it only sees top-level args), so under enforcement they fail closed rather than
 * silently linking/creating cross-tenant rows. Lifted once composite FKs make
 * parent/child consistency DB-enforced.
 */
function refuseNestedRelationWrite(model: string, data: unknown): void {
  if (hasNestedRelationWrite(data)) {
    throw new TenantScopeError(
      `Nested relation write on ${model} is refused under tenant enforcement (top-level guard cannot stamp nested rows; use flat writes until composite FKs land)`,
    );
  }
}

function buildClient(base: PrismaClient) {
  return base.$extends({
    query: {
      // Each hook composes two independent concerns on `args`: the tenant guard
      // (`scopeArgs`, DORMANT until `tenantEnforcing()`) and the soft-delete
      // filter (`addAlive*`). With enforcement off, `scopeArgs` is the identity,
      // so this block behaves exactly as the soft-delete-only version did.
      $allModels: {
        async findMany({ model, args, query }: any) {
          return query(addAliveFilter(model, scopeArgs(model, "where", args)));
        },
        async findFirst({ model, args, query }: any) {
          return query(addAliveFilter(model, scopeArgs(model, "where", args)));
        },
        async findFirstOrThrow({ model, args, query }: any) {
          return query(addAliveFilter(model, scopeArgs(model, "where", args)));
        },
        // Tenant scoping is injected into the `where` (DB-level, extendedWhereUnique)
        // so a cross-tenant row is never fetched; filteredUnique then applies only
        // the soft-delete result check.
        async findUnique({ model, args, query }: any) {
          return filteredUnique(model, scopeArgs(model, "where", args), query, false);
        },
        async findUniqueOrThrow({ model, args, query }: any) {
          return filteredUnique(model, scopeArgs(model, "where", args), query, true);
        },
        // Writes are stamped with the owning tenant from trusted context,
        // overwriting any client-supplied `tenantId` (the anti-forgery rule).
        async create({ model, args, query }: any) {
          return query(scopeArgs(model, "create", args));
        },
        async createMany({ model, args, query }: any) {
          return query(scopeArgs(model, "create", args));
        },
        async createManyAndReturn({ model, args, query }: any) {
          return query(scopeArgs(model, "create", args));
        },
        // Mutations are guarded too, not just reads: a trashed row must not be
        // updatable/deletable through the filtered client (Trash/restore/purge
        // use basePrisma). update/delete throw on a trashed row; the *Many forms
        // skip it. The tenant guard additionally scopes the `where` to the caller's
        // tenant so you can only touch your own rows.
        async update({ model, args, query }: any) {
          return query(addAliveMutationFilter(model, scopeArgs(model, "mutation", args)));
        },
        async updateMany({ model, args, query }: any) {
          return query(addAliveMutationFilter(model, scopeArgs(model, "mutation", args)));
        },
        async updateManyAndReturn({ model, args, query }: any) {
          return query(addAliveMutationFilter(model, scopeArgs(model, "mutation", args)));
        },
        async delete({ model, args, query }: any) {
          return query(addAliveMutationFilter(model, scopeArgs(model, "mutation", args)));
        },
        async deleteMany({ model, args, query }: any) {
          return query(addAliveMutationFilter(model, scopeArgs(model, "mutation", args)));
        },
        // upsert is NOT soft-delete-guarded (injecting `deletedAt` into its unique
        // where would force a spurious create on a trashed row). The tenant guard
        // DOES scope its where (Prisma 6 extendedWhereUnique) + stamp create +
        // guard update, so a cross-tenant upsert misses and takes the (stamped)
        // create branch instead of updating another tenant's row. See scopeUpsert.
        async upsert({ model, args, query }: any) {
          return query(scopeArgs(model, "upsert", args));
        },
        async count({ model, args, query }: any) {
          return query(addAliveFilter(model, scopeArgs(model, "where", args)));
        },
        async aggregate({ model, args, query }: any) {
          return query(addAliveFilter(model, scopeArgs(model, "where", args)));
        },
        async groupBy({ model, args, query }: any) {
          return query(addAliveFilter(model, scopeArgs(model, "where", args)));
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

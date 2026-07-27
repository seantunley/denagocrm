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

// One raw PrismaClient shared by both exported clients so they use the same
// connection pool. Never exported — callers use `basePrisma` or `prisma`.
const globalForPrisma = globalThis as unknown as {
  _rawPrisma?: PrismaClient;
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

function refuseNestedRelationWrite(model: string, data: unknown): void {
  if (hasNestedRelationWrite(data)) {
    throw new TenantScopeError(
      `Nested relation write on ${model} is refused under tenant enforcement (top-level guard cannot stamp nested rows; use flat writes until composite FKs land)`,
    );
  }
}

/**
 * Inject the Postgres RLS session variable for this query.
 *
 * EVERY query via `prisma` (the scoped client) runs inside a transaction where
 * SET LOCAL sets either `app.current_tenant` (tenant scope) or `app.bypass_rls`
 * (system scope, off-mode, and rollback).
 *
 * Connection-binding guarantee: Prisma's interactive transaction pins a single
 * DB connection for the duration of the `$transaction` callback and propagates
 * that connection through AsyncLocalStorage. Both `raw.$executeRaw` and
 * `query()` called inside the same callback execute on that pinned connection —
 * even though the code uses `raw` rather than the implicit `tx` argument —
 * because AsyncLocalStorage routes all Prisma operations in the same async
 * context to the pinned connection. This is exactly what Prisma's transaction
 * isolation model relies on. With pgbouncer in transaction mode, the connection
 * is held for the lifetime of the BEGIN…COMMIT block, so SET LOCAL and the
 * business query are always on the same physical connection.
 *
 * `basePrisma` always sets `app.bypass_rls = 'on'` — trusted system path.
 *
 * CRITICAL: FORCE RLS is always live in the DB once the migration is applied.
 * Even in off/monitor mode the app must set one of the two GUCs before every
 * query, otherwise no rows are returned. bypass_rls='on' is the safe default
 * for any non-tenant context (off, monitor, system scope, rollback).
 */
async function withRlsScope(raw: PrismaClient, query: () => Promise<any>): Promise<any> {
  // Under enforcement, use the current async scope to choose the GUC.
  // Off/monitor (or enforce with system scope): fall through to bypass below.
  const scope = tenantEnforcing() ? currentTenantScope() : null;
  if (scope?.tenantId) {
    const tid = scope.tenantId;
    return raw.$transaction(async () => {
      await raw.$executeRaw`SELECT set_config('app.current_tenant', ${tid}, TRUE)`;
      return query();
    });
  }
  // off/monitor, system scope, or enforce+no-scope (Layer 1 scopeArgs already
  // threw TenantScopeError for any tenant-scoped model before we reach here).
  return raw.$transaction(async () => {
    await raw.$executeRaw`SELECT set_config('app.bypass_rls', 'on', TRUE)`;
    return query();
  });
}

function buildClient(raw: PrismaClient) {
  // Layer 1: soft-delete filter + tenant scope arg manipulation (app-layer guard)
  const guarded = raw.$extends({
    query: {
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
        async findUnique({ model, args, query }: any) {
          return filteredUnique(model, scopeArgs(model, "where", args), query, false);
        },
        async findUniqueOrThrow({ model, args, query }: any) {
          return filteredUnique(model, scopeArgs(model, "where", args), query, true);
        },
        async create({ model, args, query }: any) {
          return query(scopeArgs(model, "create", args));
        },
        async createMany({ model, args, query }: any) {
          return query(scopeArgs(model, "create", args));
        },
        async createManyAndReturn({ model, args, query }: any) {
          return query(scopeArgs(model, "create", args));
        },
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

  // Layer 2: RLS session-variable injection (wraps Layer 1 in a transaction
  // that sets SET LOCAL app.current_tenant before the guarded query runs).
  // Only active when tenantEnforcing() returns true.
  return guarded.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, query }: any) {
          return withRlsScope(raw, () => query(args));
        },
      },
    },
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const _rawPrisma = globalForPrisma._rawPrisma ?? new PrismaClient();

/**
 * Trusted system client — bypasses soft-delete filter and tenant scope guard.
 * Under RLS enforcement, every operation is wrapped in a transaction that sets
 * `app.bypass_rls = 'on'` so the DB-layer FORCE RLS policy permits it.
 *
 * Use for: backups, trash, restore, purge, session management, audit, and any
 * business transaction that needs explicit row locks or cross-tenant access.
 * NOT for user-facing reads — use `prisma` instead.
 */
const _basePrismaExtended = _rawPrisma.$extends({
  query: {
    $allModels: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async $allOperations({ args, query }: any) {
        // Always bypass — basePrisma is the trusted system path. FORCE RLS is
        // always live in the DB once the migration is applied, so we must set
        // bypass_rls=on regardless of tenantEnforcing() (off/monitor/rollback
        // included — otherwise queries silently return zero rows).
        return _rawPrisma.$transaction(async () => {
          await _rawPrisma.$executeRaw`SELECT set_config('app.bypass_rls', 'on', TRUE)`;
          return query(args);
        });
      },
    },
  },
});

// Patch the FOUR standalone raw methods to set bypass_rls before executing.
// query.$allModels.$allOperations only covers Prisma model operations; standalone
// $executeRaw(Unsafe) / $queryRaw(Unsafe) calls bypass the extension and would be
// silently blocked by FORCE RLS without this. Leaving the *Unsafe variants
// unpatched is a real hole: trusted code (seed's PipelineStage insert, the
// integrity suite) calls basePrisma.$executeRawUnsafe, which under a non-bypass
// production role would run with no app.bypass_rls set. Inside basePrisma.$transaction,
// standalone raw calls are patched individually below; raw calls made INSIDE an
// interactive basePrisma.$transaction are covered by the $transaction wrapper.
/* eslint-disable @typescript-eslint/no-explicit-any */
const _basePrismaFull = _basePrismaExtended as any;
const patchRaw = (method: "$executeRaw" | "$queryRaw" | "$executeRawUnsafe" | "$queryRawUnsafe") => {
  _basePrismaFull[method] = (sql: any, ...values: any[]) =>
    _rawPrisma.$transaction(async (tx: any) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', TRUE)`;
      return (tx as any)[method](sql, ...values);
    });
};
patchRaw("$executeRaw");
patchRaw("$queryRaw");
patchRaw("$executeRawUnsafe");
patchRaw("$queryRawUnsafe");

// Interactive-transaction bypass. basePrisma is the trusted bypass client, so its
// $transaction callback must run with bypass for its ENTIRE body.
//
// CRITICAL: the callback runs on the UN-extended `_rawPrisma`, not the extended
// client. The extension (above) wraps EVERY model op in its own nested
// `_rawPrisma.$transaction(...)` to self-set bypass. Nesting those per-op
// transactions inside an interactive transaction disturbs the pinned connection's
// transaction-local GUC state, so a single `set_config(..., TRUE)` set once at the
// top would be gone by the time a later standalone `tx.$executeRaw` / `tx.$queryRaw`
// runs — a raw WRITE to a FORCE-RLS table then silently filters to zero rows and a
// raw `FOR UPDATE` lock becomes a no-op (createTenant's owner-disable UPDATE hit
// exactly this). Running the callback on the raw client means `tx` is a plain
// interactive client with NO per-op nesting, so the one top-of-body `set_config`
// persists for the whole transaction and covers every model AND raw statement. The
// base extension only adds bypass (no client/result methods), so a raw `tx` is
// behaviourally identical for callers. The array form takes already-wrapped
// extended model-op promises (each self-bypasses), so it keeps the extended path.
const _rawTransaction = _rawPrisma.$transaction.bind(_rawPrisma);
const _origTransaction = _basePrismaExtended.$transaction.bind(_basePrismaExtended);
_basePrismaFull.$transaction = (arg: any, opts: any) => {
  if (typeof arg === "function") {
    return _rawTransaction(async (tx: any) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', TRUE)`;
      return arg(tx);
    }, opts);
  }
  return _origTransaction(arg, opts);
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export const basePrisma =
  (globalForPrisma.basePrisma as PrismaClient | undefined) ??
  // Type assertion: the extended client has the same runtime API as PrismaClient;
  // the $extends wrapper only adds extension metadata to the type. Callers that
  // accept PrismaClient (provisioning.ts, etc.) work correctly at runtime.
  (_basePrismaFull as unknown as PrismaClient);

/** Default client: soft-deleted records are hidden; tenant scope is enforced when
 *  TENANT_ENFORCEMENT=enforce; DB-layer RLS is injected via SET LOCAL. */
export const prisma = globalForPrisma.prisma ?? buildClient(_rawPrisma);

if (process.env.NODE_ENV !== "production") {
  globalForPrisma._rawPrisma = _rawPrisma;
  globalForPrisma.basePrisma = basePrisma;
  globalForPrisma.prisma = prisma;
}

/**
 * TEST ONLY. Wrap an arbitrary raw PrismaClient with the SAME scoped-client
 * pipeline the exported `prisma` uses — the real `buildClient` → `withRlsScope`
 * (SET LOCAL app.current_tenant/app.bypass_rls) + tenant-guard `scopeArgs`. The
 * RLS proof (scripts/test-rls-restricted.ts) uses this to drive the REAL
 * implementation over a connection opened as a NOSUPERUSER NOBYPASSRLS role, so
 * FORCE ROW LEVEL SECURITY is actually exercised (the default CI/superuser role
 * bypasses RLS entirely, which would make an isolation assertion meaningless).
 * Not for application code — use `prisma`.
 */
export function __buildScopedClientForTests(raw: PrismaClient): PrismaClient {
  return buildClient(raw) as unknown as PrismaClient;
}

/**
 * TEST ONLY. A bypass wrapper (always sets app.bypass_rls='on') over an arbitrary
 * raw client — the `basePrisma` equivalent — so the proof can show the SAME
 * restricted role sees every tenant's rows once bypass is set, and none without.
 */
export function __buildBypassClientForTests(raw: PrismaClient): PrismaClient {
  return raw.$extends({
    query: {
      $allModels: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async $allOperations({ args, query }: any) {
          return raw.$transaction(async () => {
            await raw.$executeRaw`SELECT set_config('app.bypass_rls', 'on', TRUE)`;
            return query(args);
          });
        },
      },
    },
  }) as unknown as PrismaClient;
}

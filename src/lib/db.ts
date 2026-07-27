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
 * Connection-binding guarantee: this uses Prisma's BATCH (array) transaction —
 * `client.$transaction([ setGuc, op ])` — which is the documented Prisma pattern
 * for RLS in a query extension. Both promises are created from the SAME `client`,
 * and Prisma runs an array transaction as one BEGIN…COMMIT on a single pinned
 * connection, executing the elements IN ORDER: the `SET LOCAL` GUC runs first,
 * then the guarded operation sees it. This does NOT rely on AsyncLocalStorage
 * propagating a connection from an interactive-callback `tx` to an operation
 * invoked on a different client handle — the failure mode where the business
 * query could land on another pooled connection with no GUC set. With pgbouncer
 * in transaction mode the connection is held for the BEGIN…COMMIT block, so
 * SET LOCAL and the business query are always on the same physical connection.
 *
 * `basePrisma` always sets `app.bypass_rls = 'on'` — trusted system path.
 *
 * CRITICAL: FORCE RLS is always live in the DB once the migration is applied.
 * Even in off/monitor mode the app must set one of the two GUCs before every
 * query, otherwise no rows are returned. bypass_rls='on' is the safe default
 * for any non-tenant context (off, monitor, system scope, rollback).
 */
async function withRlsScope(client: any, query: () => any): Promise<any> {
  // Under enforcement with a tenant scope, pin app.current_tenant; otherwise
  // (off/monitor, system scope, or enforce+no-scope — Layer 1 scopeArgs already
  // threw TenantScopeError for any tenant-scoped model before we reach here) bypass.
  const scope = tenantEnforcing() ? currentTenantScope() : null;
  // Batch the GUC write and the operation in ONE array transaction on the SAME
  // `client` — the documented Prisma RLS-extension pattern. `client.$executeRaw`
  // (not a model op, so it does not re-enter this extension) sets the GUC first,
  // then the guarded op runs on the same pinned connection and sees it. The
  // restricted-role (NOSUPERUSER NOBYPASSRLS) proof exercises this under FORCE RLS.
  const setGuc = scope?.tenantId
    ? client.$executeRaw`SELECT set_config('app.current_tenant', ${scope.tenantId}, TRUE)`
    : client.$executeRaw`SELECT set_config('app.bypass_rls', 'on', TRUE)`;
  const [, result] = await client.$transaction([setGuc, query()]);
  return result;
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

  // Layer 2: RLS session-variable injection. Batches SET LOCAL (app.current_tenant
  // or app.bypass_rls) + the guarded op in one array transaction on the SCOPED
  // client itself (forward-referenced) — so both run on the same pinned connection
  // without relying on AsyncLocalStorage. Only active when tenantEnforcing() is true.
  // Holder breaks the type cycle: the extension closure references `ref.c` (typed
  // via the holder) rather than `scoped` directly, so TS still infers `scoped`'s
  // real client type (referencing it in its own initializer would collapse it to
  // `any` and cascade through `prisma`). `ref.c` is populated before any query runs.
  const ref: { c: any } = { c: null };
  const scoped = guarded.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, query }: any) {
          return withRlsScope(ref.c, () => query(args));
        },
      },
    },
  });
  ref.c = scoped;
  return scoped;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const _rawPrisma = globalForPrisma._rawPrisma ?? new PrismaClient();

/**
 * Build the trusted BYPASS client over `raw` — the `basePrisma` factory. Every
 * model op, standalone raw call and interactive transaction runs with
 * `app.bypass_rls='on'` so the DB-layer FORCE RLS policy permits it (backups,
 * trash, restore, purge, sessions, audit, and business transactions needing row
 * locks or cross-tenant access). NOT for user-facing reads — use `prisma`.
 *
 * ONE implementation, shared by the exported `basePrisma` AND the restricted-role
 * proof (`__buildBypassClientForTests`), so the NOSUPERUSER NOBYPASSRLS test drives
 * the EXACT production path, not a stand-in.
 *
 * Model ops use the BATCH (array) transaction — `$transaction([setGuc, op])` on the
 * same client — the only form that guarantees the SET LOCAL and the op share one
 * pinned connection. An interactive `$transaction(async tx => { SET; query(args) })`
 * runs `query(args)` on a DIFFERENT pooled connection than `tx`, so the bypass GUC
 * never reaches it — under a non-superuser role the op then silently filters to zero
 * rows / locks nothing. That was the defect this replaces.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
function buildBypassClient(raw: PrismaClient): PrismaClient {
  // Holder breaks the self-reference cycle; populated before any query runs. It
  // captures the NATIVE $transaction/$executeRaw so the model-op batch never
  // re-enters the patched (own-transaction-opening) versions defined below —
  // which would break the array batch.
  const nat: { tx: any; execRaw: any } = { tx: null, execRaw: null };
  const ext = raw.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, query }: any) {
          const [, result] = await nat.tx([
            nat.execRaw`SELECT set_config('app.bypass_rls', 'on', TRUE)`,
            query(args),
          ]);
          return result;
        },
      },
    },
  });
  nat.tx = ext.$transaction.bind(ext);
  nat.execRaw = ext.$executeRaw.bind(ext);

  const full = ext as any;
  // Standalone raw methods don't hit $allModels, so patch each to set bypass in its
  // own transaction (covers seed's PipelineStage insert, the integrity suite, etc.).
  for (const method of ["$executeRaw", "$queryRaw", "$executeRawUnsafe", "$queryRawUnsafe"] as const) {
    full[method] = (sql: any, ...values: any[]) =>
      raw.$transaction(async (tx: any) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', TRUE)`;
        return (tx as any)[method](sql, ...values);
      });
  }
  // Interactive $transaction: run the whole callback on the raw `tx` with bypass set
  // once at the top (no per-op nesting to disturb the transaction-local GUC), so a
  // later raw WRITE / FOR UPDATE inside the body keeps bypass. Array form keeps the
  // native extended path (its elements each self-bypass).
  full.$transaction = (arg: any, opts: any) => {
    if (typeof arg === "function") {
      return raw.$transaction(async (tx: any) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', TRUE)`;
        return arg(tx);
      }, opts);
    }
    return nat.tx(arg, opts);
  };
  return full as PrismaClient;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export const basePrisma =
  (globalForPrisma.basePrisma as PrismaClient | undefined) ??
  buildBypassClient(_rawPrisma);

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
  // Same builder the exported `basePrisma` uses, so the restricted-role proof
  // exercises the EXACT production bypass path (not a parallel stand-in).
  return buildBypassClient(raw);
}

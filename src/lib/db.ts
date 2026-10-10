import { PrismaClient } from "@prisma/client";
import { SOFT_DELETE_MODELS } from "./softDeleteModels";
import { currentTenantScope, runInTenantScope } from "./tenantScope";
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
 * Map a Prisma operation name to the scopeArgs kind. Called in Layer 2
 * (before the RLS $transaction) so AsyncLocalStorage is still reachable.
 */
function applyScopeArgs(model: string, operation: string, args: any): any {
  if (operation === "create" || operation === "createMany" || operation === "createManyAndReturn") {
    return scopeArgs(model, "create", args);
  }
  if (
    operation === "update" || operation === "updateMany" || operation === "updateManyAndReturn" ||
    operation === "delete" || operation === "deleteMany"
  ) {
    return scopeArgs(model, "mutation", args);
  }
  if (operation === "upsert") return scopeArgs(model, "upsert", args);
  // findMany/findFirst/findUnique/count/aggregate/groupBy/… → where
  return scopeArgs(model, "where", args);
}

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
/**
 * `execRaw` is the client's ORIGINAL `$executeRaw`, captured before Layer 2b
 * replaces it, and it has to be — this is the one place that cares about the
 * difference between the two.
 *
 * An array transaction requires every element to be a PrismaPromise: Prisma
 * inspects them and refuses anything else with "All elements of the array need
 * to be Prisma Client promises". Layer 2b's wrapper returns a plain Promise
 * (it awaits an interactive transaction internally), so reading `$executeRaw`
 * off the exported client here made EVERY model operation throw that error.
 * Which is what it did: unit tests are source assertions and could not see it,
 * and the restricted-role integration suite caught it on the first CI run.
 *
 * It would also have been wrong if it had worked — Layer 2b opens its own
 * transaction, so the GUC would have been set on a different connection from
 * the operation it is supposed to scope.
 */
/**
 * `transaction` is the client's ORIGINAL `$transaction`, captured before
 * Layer 2c replaces it — for the same reason `execRaw` is: Layer 2c refuses the
 * array form to callers, and this is the one place that has to keep using it.
 */
async function withRlsScope(transaction: any, execRaw: any, query: () => any): Promise<any> {
  // Under enforcement with a tenant scope, pin app.current_tenant; otherwise
  // (off/monitor, system scope, or enforce+no-scope — Layer 1 scopeArgs already
  // threw TenantScopeError for any tenant-scoped model before we reach here) bypass.
  const scope = tenantEnforcing() ? currentTenantScope() : null;
  // Batch the GUC write and the operation in ONE array transaction on the SAME
  // client — the documented Prisma RLS-extension pattern. `execRaw` (not a
  // model op, so it does not re-enter this extension) sets the GUC first, then
  // the guarded op runs on the same pinned connection and sees it. The
  // restricted-role (NOSUPERUSER NOBYPASSRLS) proof exercises this under FORCE RLS.
  const setGuc = scope?.tenantId
    ? execRaw`SELECT set_config('app.current_tenant', ${scope.tenantId}, TRUE)`
    : execRaw`SELECT set_config('app.bypass_rls', 'on', TRUE)`;
  const [, result] = await transaction([setGuc, query()]);
  return result;
}

/**
 * WHY THE ARRAY FORM IS REFUSED, ON BOTH CLIENTS.
 *
 * `$transaction([a, b])` cannot be made one transaction here. Its elements were
 * created by this client before any transaction existed, so each still runs
 * through the wrapper above — a transaction of its own that commits on its own
 * — and the raw ones are not even deferred: `$executeRaw` here returns an
 * ordinary promise that is already running by the time the array is built.
 * Measured (scripts/test-scoped-transactions.ts, before this refusal existed):
 * with two model updates and a failing third element, the first two stayed; and
 * an array of raw statements ran every statement and THEN threw Prisma's "All
 * elements of the array need to be Prisma Client promises", so the action
 * failed after its work was done.
 *
 * Refusing costs the callers nothing they had: none of them was getting a
 * transaction. The callback form is one, on both clients.
 */
function arrayTransactionRefused(): Error {
  return new Error(
    "An array passed to $transaction is not one transaction on this client — each element commits on its own. " +
      "Pass a callback instead and run the statements on its `tx`: $transaction(async (tx) => { … }).",
  );
}

/**
 * WHY A TIMELINE MESSAGE CANNOT BE CREATED INSIDE A TRANSACTION.
 *
 * `communication.create` is hooked (Layer 1) to find or open the message's
 * conversation and then recompute that conversation's counters, and both of
 * those run through `basePrisma` — ANOTHER connection. That was harmless while
 * a transaction here was not one. In a real transaction the insert on `tx`
 * takes a key-share lock on the conversation row (its foreign key), the
 * recompute then asks for that row FOR UPDATE from the other connection, and
 * the transaction waits on itself until it times out. Measured: the full
 * timeout, then "Transaction already closed", nothing saved, and an empty
 * conversation left behind by the connection that was not rolled back.
 *
 * Nothing in the app does this — every one of the message writers creates on
 * `prisma`, after its transaction if it has one — so it is refused in words
 * rather than left to be found as a twenty-second hang.
 *
 * ponytail: a refusal, not support. If a change ever has to commit together
 * with the message that records it, give conversations.ts's attach and
 * recompute a client to run on, pass `tx`, and delete this.
 */
function messageInTransactionRefused(): Error {
  return new Error(
    "A timeline message cannot be created inside a transaction: attaching it to its conversation runs on another " +
      "connection and would wait on this transaction's own locks. Create it with `prisma.communication.create` " +
      "after the transaction has committed.",
  );
}

/**
 * A REAL interactive transaction on the scoped client.
 *
 * `client` is the scoped client's sibling: the same soft-delete filter and the
 * same workspace scoping of each operation's arguments, WITHOUT the wrapper that
 * gives every operation a transaction of its own. So an operation on `tx` stays
 * on `tx`. Its raw methods are Prisma's own, bound to the transaction — not the
 * replacements Layer 2b puts on the client, which open another one.
 *
 * The workspace setting is made ONCE, as the transaction's first statement, on
 * the transaction's own connection — the same value `withRlsScope` would give
 * each operation: the caller's workspace under enforcement, the bypass
 * otherwise. `set_config(…, TRUE)` lasts until the transaction ends, so every
 * statement after it, model or raw, runs under it. A transaction therefore
 * belongs to the workspace it was opened in; a scope changed part-way through
 * the callback does not move it, and row-level security refuses what no longer
 * matches rather than letting it through.
 */
async function scopedTransaction(client: any, fn: (tx: any) => any, opts: unknown): Promise<any> {
  // The miss-path recovery Layer 2 makes per operation (see there), made once
  // for the whole transaction. It cannot widen anything: it runs only when there
  // is NO scope, and binds the signed-in person's own workspace or nothing.
  if (tenantEnforcing() && !currentTenantScope()) {
    const { recoverStaffScopeFromSession } = await import("./scopeRecovery");
    const recovered = await recoverStaffScopeFromSession();
    if (recovered) return runInTenantScope(recovered, () => scopedTransaction(client, fn, opts));
  }
  const scope = tenantEnforcing() ? currentTenantScope() : null;
  return client.$transaction(async (tx: any) => {
    if (scope?.tenantId) {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${scope.tenantId}, TRUE)`;
    } else {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', TRUE)`;
    }
    return fn(tx);
  }, opts);
}

function buildClient(raw: PrismaClient) {
  // Layer 1: soft-delete filter + tenant scope arg manipulation (app-layer guard).
  // In two steps — the filters, then the one hook that does work of its own — so
  // that a transaction (Layer 2c) can have the first without the second.
  const alive = raw.$extends({
    query: {
      $allModels: {
        async findMany({ model, args, query }: any) {
          return query(addAliveFilter(model, args));
        },
        async findFirst({ model, args, query }: any) {
          return query(addAliveFilter(model, args));
        },
        async findFirstOrThrow({ model, args, query }: any) {
          return query(addAliveFilter(model, args));
        },
        async findUnique({ model, args, query }: any) {
          return filteredUnique(model, args, query, false);
        },
        async findUniqueOrThrow({ model, args, query }: any) {
          return filteredUnique(model, args, query, true);
        },
        async create({ args, query }: any) {
          return query(args);
        },
        async createMany({ args, query }: any) {
          return query(args);
        },
        async createManyAndReturn({ args, query }: any) {
          return query(args);
        },
        async update({ model, args, query }: any) {
          return query(addAliveMutationFilter(model, args));
        },
        async updateMany({ model, args, query }: any) {
          return query(addAliveMutationFilter(model, args));
        },
        async updateManyAndReturn({ model, args, query }: any) {
          return query(addAliveMutationFilter(model, args));
        },
        async delete({ model, args, query }: any) {
          return query(addAliveMutationFilter(model, args));
        },
        async deleteMany({ model, args, query }: any) {
          return query(addAliveMutationFilter(model, args));
        },
        async upsert({ args, query }: any) {
          return query(args);
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
    },
  });
  const guarded = alive.$extends({
    query: {
      communication: {
        async create({ args, query }: any) {
          // Threading and the tenant it forces on this row are ONE decision, taken in
          // conversations.ts and applied to `args.data` before the INSERT. It used to
          // be taken here, in halves, and the half that mattered was missing: the row
          // got the thread's id and kept its SUBJECT's tenant, which the composite key
          // `Communication(tenantId, conversationId)` refuses whenever the two differ.
          // Not wrapped in a try. attachToConversation swallows exactly one failure —
          // the search for an existing thread, which leaves the row attached to
          // nothing and therefore safe — and refuses everything else. A catch here
          // would put back the wider one review removed, where a refused owner became
          // an unowned cross-tenant row instead of a failed write.
          const { attachToConversation } = await import("./conversations");
          const conversation = await attachToConversation(args.data);
          const result = await query(args);
          if (conversation) {
            try {
              const { bumpConversation } = await import("./conversations");
              await bumpConversation(conversation.id, args.data);
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
  // `execRaw` is the same client's UNWRAPPED $executeRaw, captured below before
  // Layer 2b replaces it. Layer 2 builds an ARRAY transaction, which accepts only
  // PrismaPromises; Layer 2b's replacement returns a plain Promise. See
  // withRlsScope for what happens when this distinction is lost.
  const ref: { tx: any; execRaw: any } = { tx: null, execRaw: null };
  const scoped = guarded.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }: any) {
          // POINT-OF-USE SCOPE RECOVERY, FOR SERVER ACTIONS.
          //
          // A page render always reaches here with a scope: the auth chokepoint
          // establishes one and #513's request-keyed holder carries it between
          // segments. A SERVER ACTION has no React request store, so that holder is
          // never filled, and `enterWith` does not propagate from a callee back up
          // to the frame that called it. The result is that an action authenticates
          // successfully and then refuses its own queries — the 2026-08-13 Research
          // failure, and it is reproduced by scripts/test-action-tenant-scope.ts.
          //
          // Recovering HERE rather than at each caller is what fixes the CLASS. The
          // scope is bound with `runInTenantScope` (a real enclosing frame, not
          // `enterWith`), so this query and anything nested under it can see it.
          //
          // IT CANNOT WIDEN ANYTHING. It runs only when there is NO scope, which is
          // otherwise an outright refusal — so the choice is between the acting
          // session's own workspace and a thrown error, never a different workspace.
          // An existing scope, narrower or `system`, is left untouched: this branch
          // is not reached when one is present.
          //
          // Paid ONLY on the miss path, and a miss today is a hard failure, so no
          // request that works now pays anything for it.
          if (tenantEnforcing() && isTenantScopedModel(model) && !currentTenantScope()) {
            const { recoverStaffScopeFromSession } = await import("./scopeRecovery");
            const recovered = await recoverStaffScopeFromSession();
            if (recovered) {
              return runInTenantScope(recovered, () => {
                const scopedArgs = applyScopeArgs(model, operation, args);
                return withRlsScope(ref.tx, ref.execRaw, () => query(scopedArgs));
              });
            }
          }
          // Apply tenant scoping HERE (Layer 2), before withRlsScope's $transaction.
          // Prisma's array $transaction loses AsyncLocalStorage context inside its
          // execution callbacks, so currentTenantScope() is unreachable in Layer 1.
          const scopedArgs = applyScopeArgs(model, operation, args);
          return withRlsScope(ref.tx, ref.execRaw, () => query(scopedArgs));
        },
      },
    },
  });
  // BEFORE the code below overwrites them. Bound, because they are read off the
  // client here and called bare later.
  ref.execRaw = (scoped as any).$executeRaw.bind(scoped);
  ref.tx = (scoped as any).$transaction.bind(scoped);

  // Layer 2b: THE SAME GUC, for RAW queries.
  //
  // A Prisma query extension intercepts MODEL operations. `$queryRaw` and friends
  // are not model operations, so everything above — the tenant scoping AND the
  // SET LOCAL that makes FORCE RLS permit the row — skipped them entirely. The
  // fourteen raw reads issued through this client therefore ran with NO GUC set
  // at all, and worked only because the application role still carries
  // `rolbypassrls`. Under the restricted role the RLS work is heading for they
  // would have returned zero rows: the leads board empty, the stock dashboard
  // blank, timeline pins gone, and a job-card write silently matching nothing.
  //
  // src/app/actions/portal.ts already documents this exact trap for its own raw
  // lookup and side-steps it by using basePrisma. That is the right answer for a
  // PRE-AUTH lookup with no tenant to scope to. It is the wrong answer for a
  // user-facing read, which is what these are: basePrisma sets bypass, so
  // "fixing" them that way would have turned fourteen tenant-scoped reads into
  // fourteen cross-tenant ones the moment isolation was switched on.
  //
  // So the GUC is applied here instead, once, with the same rule withRlsScope
  // uses: the caller's tenant when enforcing with a scope, bypass otherwise.
  // Fixing it in the client rather than at the call sites also means the next raw
  // query somebody writes is correct without them knowing any of this.
  //
  // The INTERACTIVE form, not the array form withRlsScope uses. That choice is
  // load-bearing and the opposite of the model-op case: here the raw method is
  // invoked ON `tx` itself, so it is by construction on the same pinned
  // connection as the SET LOCAL. (buildBypassClient does exactly this, for
  // exactly this reason.) An array transaction cannot express it, because the
  // raw promise would have to be created from the outer client first.
  //
  // DORMANT TODAY, byte-for-byte: with enforcement off this sets
  // `app.bypass_rls='on'`, which is what the current role does implicitly
  // anyway, so every one of these queries returns exactly what it returns now.
  const scopedFull = scoped as any;
  for (const method of ["$executeRaw", "$queryRaw", "$executeRawUnsafe", "$queryRawUnsafe"] as const) {
    scopedFull[method] = (sql: any, ...values: any[]) =>
      raw.$transaction(async (tx: any) => {
        const scope = tenantEnforcing() ? currentTenantScope() : null;
        if (scope?.tenantId) {
          await tx.$executeRaw`SELECT set_config('app.current_tenant', ${scope.tenantId}, TRUE)`;
        } else {
          await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', TRUE)`;
        }
        return tx[method](sql, ...values);
      });
  }

  // Layer 2c: A TRANSACTION THAT IS ONE.
  //
  // `prisma.$transaction(async (tx) => …)` is how this codebase says "these
  // changes belong together", and until this layer it was not a transaction.
  // The `tx` Prisma handed back was still THIS client, so every model operation
  // on it went through Layer 2 — whose batch replaces the transaction it was
  // called in with one of its own — and every raw statement went through
  // Layer 2b, which opens another. Each statement committed as it ran, on some
  // other connection, while the interactive transaction sat idle and committed
  // nothing at the end.
  //
  // Measured, with enforcement off and on (scripts/test-scoped-transactions.ts
  // against the code before this layer): a throw kept every write made before
  // it; `SELECT … FOR UPDATE` and `pg_advisory_xact_lock` on `tx` were released
  // before the next line; and a callback that overran its timeout was reported
  // as failed with all of its work saved.
  //
  // The callers were written for the real thing — lib/journeyArbitration.ts is
  // the one place that had noticed, and worked round it. So the fix is here, in
  // one place: the callback form opens its transaction on a SIBLING client that
  // scopes each operation's arguments exactly as Layer 2 does and adds no
  // transaction of its own. See scopedTransaction.
  //
  // Built on `alive`, NOT `guarded`. An extension added earlier runs earlier, so
  // on `guarded` the message hook would already have opened a conversation on
  // another connection before anything here could stop it. The filters are
  // kept; the hook is replaced by a refusal — see messageInTransactionRefused.
  const inTransaction = alive.$extends({
    query: {
      communication: {
        async create() {
          throw messageInTransactionRefused();
        },
      },
      $allModels: {
        async $allOperations({ model, operation, args, query }: any) {
          return query(applyScopeArgs(model, operation, args));
        },
      },
    },
  });
  scopedFull.$transaction = (arg: any, opts?: any) =>
    typeof arg === "function"
      ? scopedTransaction(inTransaction, arg, opts)
      : Promise.reject(arrayTransactionRefused());

  return scoped;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Interactive transactions get longer than Prisma's defaults (maxWait 2s,
 * timeout 5s), because those defaults assume a database next door.
 *
 * This one is not. Measured against the hosted database, a single round trip
 * runs 300–700ms, and the business transactions here are not short: each takes
 * a `SELECT … FOR UPDATE`, re-reads the row to re-check its state under the
 * lock, does its writes, and — on the RLS-scoped client — spends a further
 * round trip on `SET LOCAL` before any of that. createQuoteRevision and
 * saveQuoteDraft are ~7-10 trips, which lands either side of 5s depending on
 * the day, and a transaction that overruns fails with P2028 AFTER the user has
 * done the work rather than rolling back cheaply.
 *
 * The cost of a longer ceiling is a row lock held longer when something hangs.
 * These lock a single quote / lead / job-card row and contention is low, so
 * losing a revision to a stopwatch is much the worse trade. Overridable for a
 * deployment sitting closer to its database.
 */
const txMs = (name: string, fallback: number) => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

/**
 * THE ROLE THE APPLICATION CONNECTS AS — `APP_DATABASE_URL` when set, otherwise
 * `DATABASE_URL` exactly as before.
 *
 * WHY THIS IS NOT IN schema.prisma. RLS is only a boundary when the connecting
 * role cannot step over it, and `neondb_owner` carries BYPASSRLS — so every
 * policy on all 120 forced tables has been evaluated exactly never. The fix is
 * to connect as `crm_app` (NOSUPERUSER NOBYPASSRLS), verified against production
 * 2026-08-12: with no tenant set, `Contact` returns 0 rows; with
 * `app.bypass_rls='on'`, 18.
 *
 * `DATABASE_URL` cannot simply be repointed. It is owned by the Neon–Vercel
 * integration, which offers no edit and re-syncs it — and, more importantly,
 * SUBSTITUTES A DIFFERENT VALUE PER DEPLOYMENT so each preview gets its own Neon
 * branch. Hardcoding a production string over that is the 2026-07-24 incident
 * again: previews sharing the live database, which is what preview-database.yml
 * exists to prevent.
 *
 * So the override is applied HERE, at the one client construction, with a
 * fallback — rather than in `schema.prisma`, where `env()` takes no fallback and
 * every environment would have to define the new name or fail to boot:
 *
 *   production  APP_DATABASE_URL set   → crm_app, RLS enforced
 *   preview     unset                  → the integration's per-branch URL
 *   CI / local  unset                  → DATABASE_URL, unchanged
 *
 * `directUrl` is deliberately untouched: migrations run through
 * `DATABASE_URL_UNPOOLED` as the owner, because `crm_app` has no DDL rights.
 * Operator scripts that build their own PrismaClient also keep reading
 * `DATABASE_URL` and so keep running as the owner — which is correct for them,
 * and avoids the failure where a script returns zero rows with no error.
 */
const appDatabaseUrl = process.env.APP_DATABASE_URL?.trim() || undefined;

const _rawPrisma =
  globalForPrisma._rawPrisma ??
  new PrismaClient({
    // Omitted entirely when unset — passing `datasourceUrl: undefined` is not the
    // same as not passing it, and the schema's own `url` must remain in force.
    ...(appDatabaseUrl ? { datasourceUrl: appDatabaseUrl } : {}),
    transactionOptions: {
      maxWait: txMs("PRISMA_TX_MAX_WAIT_MS", 10_000),
      timeout: txMs("PRISMA_TX_TIMEOUT_MS", 20_000),
    },
  });

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
  // later raw WRITE / FOR UPDATE inside the body keeps bypass. The array form is
  // refused: its elements each self-bypass in a transaction of their own, so it
  // was never one — see arrayTransactionRefused.
  full.$transaction = (arg: any, opts: any) => {
    if (typeof arg === "function") {
      return raw.$transaction(async (tx: any) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', TRUE)`;
        return arg(tx);
      }, opts);
    }
    return Promise.reject(arrayTransactionRefused());
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

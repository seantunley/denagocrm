# Phase C — Tenant Isolation Guard (design)

**Status:** DESIGN ONLY. No prod changes. Nothing here ships until Sean says go, with a backup taken first.
**Prereq state (done):** Phase A foundation live; `TENANT_ENFORCEMENT=monitor` live & clean; Phase B additive `tenantId` on 91 prod tables (nullable, indexed, backfilled to `tenant_denago_cpt`), nothing reads it yet.
**Goal of Phase C:** make the `tenantId` columns *load-bearing* — every read is scoped to one tenant, every write is stamped from trusted context (never client input), and Postgres refuses cross-tenant access even if the app has a bug.

Related: `MULTITENANCY-SCOPING.md` (§1a decision, §1b graduation), memory `tenant-isolation-architecture`, `multi-tenancy-progress`.

---

## 0. Design principles (non-negotiable)

1. **Fail closed, not open.** A request with no resolvable tenant must get *nothing*, never *everything*. The pre-tenancy default (no filter) is the dangerous state.
2. **Defence in depth = two independent layers.** (a) App-level auto-scoping in `db.ts`; (b) Postgres RLS underneath. Either alone is a single point of failure. RLS is the one that holds when the app has a bug.
3. **Tenant comes from the session, never from the caller's `data`/`where`.** A write's `tenantId` is derived from request context; a client-supplied `tenantId` is ignored (or rejected). This is the whole ballgame — it's how you stop tenant A writing rows tagged tenant B.
4. **Children inherit from parents.** A `QuoteItem`'s tenant is `Quote.tenantId`, not something the caller passes. (Reviewer's explicit requirement.)
5. **Everything flag-gated on `tenantEnforcing()`** — the single dormant hook in `tenantEnforcement.ts` (currently hard-wired `false`). No behaviour changes until that flips, and it flips per-environment (preview → prod) via env, no code deploy.
6. **Lockout-proof rollout.** Every step is individually reversible and verified as a constrained (non-owner) user before the next. Sean's hard rule.

---

## 1. The core: `db.ts` request-scoped tenant guard

### 1.1 Tenant context propagation — `AsyncLocalStorage`

There is no `AsyncLocalStorage` in the codebase today. Introduce one so any DB call, however deep, can find "who is this request for" without threading it through every function.

```ts
// src/lib/tenantContext.ts  (new)
import { AsyncLocalStorage } from "node:async_hooks";

type TenantCtx = { tenantId: string | null; system: boolean };
const als = new AsyncLocalStorage<TenantCtx>();

export function runInTenant<T>(ctx: TenantCtx, fn: () => Promise<T>): Promise<T> {
  return als.run(ctx, fn);
}
export function currentTenant(): TenantCtx | undefined {
  return als.getStore();
}
```

Where it's established: one place, early in the request lifecycle. Options, in order of preference:
- **Preferred:** a wrapper in the auth layer — everything already funnels through `getCurrentUser()` / `getActiveTenantId()` (`auth.ts:217`). Add a `withTenantContext(handler)` used by route handlers / server actions that resolves the tenant once and enters `runInTenant`.
- Cron / webhooks / public routes get an *explicit* `system` context (see §4) — they never inherit a user tenant.

### 1.2 The guard extension (composes with the existing soft-delete extension)

`db.ts` already wraps `basePrisma` with a `$extends({ query: { $allModels: {...} } })` that injects `deletedAt: null`. The tenant guard is a **second concern layered in the same `$allModels` hooks** (or a second `$extends` — Prisma composes them). Pseudocode, per operation:

```ts
// READS (findMany/findFirst/findUnique*/count/aggregate/groupBy):
//   inject where.tenantId = ctx.tenantId  (unless model is GLOBAL, see §1.4)
// WRITES (create/createMany):
//   force data.tenantId = ctx.tenantId    (overwrite any client value)
// MUTATIONS (update/delete/*Many/upsert):
//   inject where.tenantId = ctx.tenantId  so you can only touch your own rows
```

Fail-closed rule, gated:

```ts
if (tenantEnforcing() && !isGlobalModel(model)) {
  const ctx = currentTenant();
  if (!ctx) throw new TenantContextError(`No tenant context for ${model}.${op}`);
  if (ctx.system) return query(args);          // explicit system escape hatch
  if (!ctx.tenantId) throw new TenantContextError(`Null tenant for ${model}.${op}`);
  args = injectTenant(model, op, args, ctx.tenantId);
}
return query(args);   // when tenantEnforcing() === false → today's behaviour, unchanged
```

Because the whole block is behind `tenantEnforcing()`, merging this PR changes **nothing** in prod until the env flag flips. That's the safety valve.

### 1.3 Parent/child tenant consistency (principle #4) — LOCKED strategy

A Prisma query extension only sees TOP-LEVEL args, so the app guard cannot safely
stamp or validate nested rows. Parent/child consistency is therefore enforced by a
combination, NOT by the app guard alone, and NOT by RLS alone:

- **Nested relation writes** (`quote: { create: { items: { create: [...] } } }`,
  `connect`, `connectOrCreate`, nested `update`/`upsert`): the guard **refuses**
  them under enforcement (`hasNestedRelationWrite` → `TenantScopeError`, fail
  closed) — it cannot stamp what it cannot see. Callers use flat writes, or the
  refusal is lifted per-relation once composite FKs (below) make the link safe.
- **Direct child creates with a scalar parent FK** (`quoteItem.create({ data: {
  quoteId } })`): the guard stamps the child's own `tenantId` but does **NOT**
  prove `quoteId` belongs to that tenant, and **RLS does not close this** — a
  single-column FK only checks the parent id exists; a row policy only checks the
  child's own `tenantId`. Closed instead by **tenant-aware composite foreign
  keys**: parent gets `UNIQUE(tenantId, id)`, child FK becomes
  `(tenantId, quoteId) → Quote(tenantId, id)`, so the DB rejects a child pointing
  at another tenant's parent. Added in the FK step (§5). A cheaper app-level
  complement — resolve the parent's `tenantId` via `basePrisma` and compare —
  MAY be added, but the composite FK is the authoritative guarantee.

So the three layers are complementary: **this guard** = top-level scoping +
anti-forgery stamping + nested-write refusal; **RLS** = authoritative ROW-level
tenant match; **composite FKs** = authoritative CROSS-ROW (parent/child) match.
Enforcement stays gated until RLS + composite FKs are live (§6).

### 1.4 Global (non-scoped) models — the allow-list

Not every table is tenant-owned. The guard must **skip** these or it will break auth. Maintain an explicit `GLOBAL_MODELS` set:
`User`, `Tenant`, `TenantMember`, `ErrorLog`, `OtpChallenge`, `Passkey`, `PushSubscription`.
(`User` is cross-tenant by design — membership model.) **`AppSetting` is NOT global** — per decision 3 it becomes tenant-scoped (needs the additive `tenantId` slice first), so it is deliberately absent from this list.

Everything **not** in this set is tenant-scoped. Fail closed on unknown models = safer than an opt-in list that forgets a table.

### 1.5 `basePrisma` stays the deliberate escape hatch

`basePrisma` (raw, unfiltered) already exists for backups/trash/restore/purge and row-lock transactions. It is **not** tenant-guarded — by design. Phase C rule: any `basePrisma` business use must add its own `tenantId` predicate, exactly as it already must add `deletedAt: null` (documented in `db.ts`). Audit every `basePrisma` call site as part of the guard PR; the risky ones are `quoteLock`, `claimPartStock`, `reservePart`, `merge`, backups, and the cross-tenant admin/provisioning paths.

---

## 2. Postgres RLS — the fail-closed backstop

App-level scoping catches 99%; RLS catches the bug in the other 1% (a forgotten `where`, a raw query, a `basePrisma` slip).

### 2.1 Per-request GUC

Each request sets a transaction-local setting; policies read it:

```sql
-- policy (repeated per tenant-owned table)
ALTER TABLE "Quote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Quote" FORCE ROW LEVEL SECURITY;   -- applies even to table owner
CREATE POLICY tenant_isolation ON "Quote"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
```

### 2.2 The pooling wrinkle (important — we use pgbouncer transaction mode)

`DATABASE_URL` is the Neon **pooler** (`-pooler`, pgbouncer, *transaction* pooling). A plain `SET app.tenant_id` at session level does **not** survive across pooled statements. Correct approaches:
- Use `set_config('app.tenant_id', $1, true)` (the `true` = **transaction-local**) inside a `prisma.$transaction(...)`, wrapping the actual query. Prisma interactive transactions pin a single connection, so the GUC and the query share it.
- **Or** run the tenant-scoped workload through `DATABASE_URL_UNPOOLED` (direct) where session GUCs are safe — heavier on connections, only for specific jobs.

**Design decision:** wrap tenant-scoped requests in a `$transaction` that first `set_config(..., true)` then runs the work. The `db.ts` guard's context-entry (§1.1) is the natural place to open that transaction. This is the fiddliest part of Phase C and gets its own spike + test before rollout.

### 2.3 A `system`/superuser bypass role

Backups, migrations, cron, and cross-tenant admin need to see all rows. `FORCE ROW LEVEL SECURITY` blocks even the owner, so provide a **`BYPASSRLS`** role (or a policy keyed to a `app.system = 'on'` GUC) that the `system` context (§4) uses. Migrations run as the bypass role. Never expose this role to a user-facing request path.

---

## 3. Uniqueness re-scoping

Global `@unique` on a **business key** is a cross-tenant collision waiting to happen (tenant B can't reuse quote #1001). Re-scope business keys to `@@unique([tenantId, key])`; leave genuinely-global keys alone.

**Rule:** scope it if the value is *chosen within a tenant* (numbers, names, slugs, human keys). Keep it global if it's an *unguessable token*, an *externally-defined id*, or *cross-tenant identity*.

### Must become `@@unique([tenantId, x])` (business keys)

| Model / field | Line | Note |
|---|---|---|
| `Quote.number` | 649 | already flagged; **needs the `Int @unique` → composite swap + backfill** |
| `JobCard.number` | 1071 | same pattern |
| `Invoice.number` (`BigInt @default(autoincrement())`) | 1818 | autoincrement + per-tenant is awkward — see note below |
| `StockUnit.stockNumber` | 182 | per-tenant stock numbering |
| `Tag.name` | 406 | per-tenant tags |
| `Mailbox.slug` | 1938 | per-tenant mailbox |
| `Team.slug` | 1958 | per-tenant team |
| `BotSession @@unique([channel, key])` | 492 | → `([tenantId, channel, key])` |
| `Target @@unique([metric, period])` | 1359 | → `([tenantId, metric, period])` |
| `CustomFieldDef @@unique([entity, key])` | 2136 | → `([tenantId, entity, key])` |

**Invoice.number caveat:** a global `autoincrement()` can't become per-tenant sequential without an app-side per-tenant counter (or keep the global surrogate unique *and* add a separate per-tenant display number). Decide before this PR; don't silently break invoice numbering.

### Stays global (do NOT scope)

- `User.email` (14) — cross-tenant identity.
- `Tenant.slug` (2166) — Tenant *is* the tenant.
- All unguessable tokens / hashes / external ids: `signToken`, `token`, `jti`, `credentialId`, `externalKey`, `dedupeKey`, `sourceMessageId`, `storedName`, `vin`, `endpoint`, `referralCode`, `messengerPsid`, `instagramId`, `leadId`, autoincrement surrogate `number`s used only as opaque ids.
- Composites already scoped by a tenant-owned parent (`@@unique([vehicleId, dueKey])` 769, `@@unique([defId, recordId])` 2151, `@@unique([documentId, version])` 108, `@@unique([templateId, version])`) — the parent FK already confines them; scoping again is redundant. **Confirm each parent is itself tenant-scoped** before relying on this.

---

## 4. Public, unauthenticated & system contexts

These have **no logged-in user**, so they can't inherit a user tenant. Each needs an *explicit* tenant or the `system` escape hatch — the reviewer called this out specifically.

- **Public signing / customer portal** (`signToken`, `token`, per-recipient hex): resolve tenant *from the token's row* (`SignatureRequest.tenantId`, `Quote.tenantId`) and enter that tenant's context for the request. Never `system`.
- **Cron workers** (backups, reminders, service-due, digest): run per-tenant in a loop, entering each tenant's context; or `system` for genuinely cross-tenant maintenance (backup export). Backups already use `basePrisma` — keep, but they must be `system`.
- **Inbound webhooks** (email/IMAP, WhatsApp/Messenger/IG, leadgen): resolve tenant from the destination (mailbox → tenant, channel key → tenant) *before* writing. Until multi-tenant, these all resolve to `tenant_denago_cpt`.
- **Intake / widget API**: resolve tenant from the API key / widget id.

---

## 5. NOT NULL + FK flip (the data-safety sequence)

Only after §1–§4 are in place and monitored clean. Per table, **in this order**, one PR per cluster (mirror Phase B):

1. **Re-verify zero NULLs immediately before** (reviewer's requirement): `SELECT count(*) FROM "T" WHERE "tenantId" IS NULL` → must be 0. Re-run the NULL-scoped backfill if not.
2. `ALTER COLUMN "tenantId" SET NOT NULL`.
3. `ADD CONSTRAINT "T_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")` — `ON DELETE RESTRICT` (never cascade-delete a tenant's data implicitly).
4. Schema: `tenantId String` (drop the `?`) + the relation.

**Tenant-aware COMPOSITE FKs (parent/child consistency — §1.3).** For every
parent→child relation between tenant-owned tables, additionally:
- parent gets `UNIQUE(tenantId, id)` (or a composite PK);
- the child's relation FK becomes `FOREIGN KEY (tenantId, <parentId>) REFERENCES Parent(tenantId, id)`, so the DB rejects a child row pointing at another tenant's parent — the gap RLS + single-column FKs leave open.

Only once these land can the guard's **nested-relation-write refusal** be relaxed per-relation (a relation with a composite FK is safe to nest). Until then, callers use flat writes under enforcement.

Backup first. This is the point of no easy return, so it's the last structural step and it's staged (preview → prod), NOT NULL flips gated behind confirmed-clean monitor logs.

---

## 6. Rollout sequence (ordered PR checklist)

Each PR is independently safe, verified as a constrained user, no CI-red merges (CI now restored):

**⚠️ RLS + composite FKs are HARD PREREQUISITES for enforcement.** The app-layer guard is defence-in-depth: Prisma extensions intercept only TOP-LEVEL operations. It refuses nested relation writes under enforcement (fail closed), but a direct child create with a cross-tenant scalar parent FK is caught by neither the guard nor RLS nor a single-column FK — only by tenant-aware **composite FKs** (§1.3/§5). So: **RLS** (authoritative row-level boundary) must be live before *any* enforcement (preview included); **composite FKs** (authoritative cross-row boundary) must be live before **prod** enforcement. `tenantEnforcing()` stays false until then.

1. **✅ `tenantScope`/`tenantGuard` + `db.ts` guard, dormant** (#165) — AsyncLocalStorage scope, full-operation guard incl. `findFirstOrThrow`/`createManyAndReturn`/`updateManyAndReturn`, DB-level `where` scoping for unique reads + upsert (extendedWhereUnique), nested-relation-write refusal (fail closed), `GLOBAL_MODELS`, testable enforcement override, pure-helper unit tests + a disposable-Postgres integration test (real extension, incl. upsert/`*ManyAndReturn`/nested-refusal) + a schema-contract test. All behind `tenantEnforcing()===false`.
2. **Establish scope at the chokepoints** (#166) — `getCurrentUser` (staff) + `getPortalContact` (portal), with auth/session validation running in a trusted `system` scope FIRST (it reads tenant-scoped `UserSession`/`AppSetting` before the tenant is known), then switching to the principal's tenant. Still inert.
3. **No-user edges** (step 2b) — cron + backup (`system`), webhooks (derived tenant; WhatsApp `phone_number_id` as the routing key), public token routes (tenant derived from the token's entity). Bypass both chokepoints; must be wired before enforcement.
4. **Audit every `basePrisma` call site** — add `tenantId` predicates to business uses; mark backups/trash/admin `system`. (Correctness even before enforcement.)
5. **`AppSetting.tenantId` additive slice** (decision 3) — nullable + index + backfill, mirror of Phase B; move settings-resolution to read request tenant (still inert). Clears the last `PENDING` model in the schema-contract test.
6. **Per-tenant invoice counter** (decision 1) — `TenantCounter` model + locked-increment in invoice create; backfill Denago's counter to `MAX(number)`. Prereq for the uniqueness swap.
7. **Uniqueness re-scoping** (§3) — composite `@@unique` swaps + backfills, incl. `Invoice.number` now that the counter exists.
8. **RLS** — enable + `FORCE ROW LEVEL SECURITY` + policies + the `set_config(...,true)` transaction wrapper + `BYPASSRLS` system role. **Preview first**; the pooling behaviour (§2.2) is the risk to prove out here.
9. **NOT NULL + FK flip + tenant-aware composite FKs** (§5) — per-cluster, backup-first. This lands the CROSS-ROW boundary. It must precede ANY enforcement, because a preview with enforcement on but no composite FKs still permits the cross-tenant parent-link the guard cannot catch (and the §7 isolation suite expects a spoofed A-child→B-parent to be refused). Relax the guard's nested-write refusal per-relation as each composite FK lands.
10. **Turn the guard on in preview** — `TENANT_ENFORCEMENT=enforce` + flip `tenantEnforcing()` to honour it, **preview env only, AFTER RLS AND composite FKs are live**. Run the isolation suite (§7). Watch monitor logs.
11. **Enforce in prod** — RLS **and composite FKs** live in prod, then flip the env, watch, keep the one-line rollback (`TENANT_ENFORCEMENT=off` / `tenantEnforcing()` guard) ready.
12. **Tenant activation flow** — only now: `createTenant` currently makes SUSPENDED tenants w/ DISABLED owners; a controlled activation enables a real second tenant once isolation is *proven*.

---

## 7. Test plan — cross-tenant isolation suite (`test:tenant`)

New suite, must pass before §5/§6 land. Seed **two** tenants (A, B) and assert, as a non-owner user of A:
- **Read isolation:** every list/detail/count for A returns zero B rows. Loop the tenant-owned models programmatically (don't hand-pick).
- **Write stamping:** a create under A's context lands `tenantId = A` even if the payload says B; a create with client `tenantId: B` is overwritten or rejected.
- **Child inheritance:** a `QuoteItem` created under A inherits A even if `quoteId` is spoofed to a B quote → refused.
- **Mutation isolation:** A cannot update/delete a B row (P2025 / zero-affected).
- **Uniqueness:** A and B can both use quote number 1001; a duplicate *within* A still collides.
- **RLS backstop:** with the app-level guard *disabled* but RLS *on*, a raw `basePrisma` query under A's GUC still returns only A rows (proves defence-in-depth).
- **Public/system paths:** a signing token for a B request, opened with no session, resolves B context and sees only B; a `system` cron sees all.
- **Fail-closed:** no context + `tenantEnforcing()` → throws, returns nothing (never everything).

Verify manually too, as a **constrained (non-owner, module-limited) user**, matching sibling route guards — the class of bug that's been missed before.

---

## 8. Rollback matrix

| Step | Rollback |
|---|---|
| Guard PR (1–3) | inert behind `tenantEnforcing()`; nothing to roll back |
| Enforce (preview/prod) | `TENANT_ENFORCEMENT=off` + redeploy → instant pre-tenancy behaviour |
| RLS | `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` (fast, reversible) |
| Uniqueness swap | keep old index until new proven; revert = drop composite, restore single |
| NOT NULL + FK | the hard one — backup first; revert = `DROP CONSTRAINT` + `DROP NOT NULL` (data already correct, so low risk once backfill verified) |

---

## 9. Decisions (Sean, 2026-07-22) — LOCKED

1. **Invoice numbering — per-tenant, no global default or tracking.** `Invoice.number` (`BigInt @default(autoincrement()) @unique`, line 1818) drops the global autoincrement + global unique entirely. Replaced with a **per-tenant counter**: a `TenantCounter(tenantId, name, value)` row incremented inside the invoice-create transaction under a row lock, so each tenant gets its own 1,2,3… with **no cross-tenant sequence and no global surrogate**. Uniqueness becomes `@@unique([tenantId, number])`. Existing Denago invoices keep their numbers (backfill the counter to `MAX(number)` for `tenant_denago_cpt`). Real work, its own PR ahead of the uniqueness batch.
2. **RLS — most secure option chosen:** `FORCE ROW LEVEL SECURITY` on every tenant-owned table (blocks even the table owner), tenant read via `current_setting('app.tenant_id', true)`, set **transaction-locally** with `set_config('app.tenant_id', $1, true)` inside the `$transaction` that wraps each tenant request — correct under the pgbouncer pooler, no reliance on session persistence. System/cron/backup use a dedicated **`BYPASSRLS` role**, never reachable from a user request path. We do **not** route tenant work through the unpooled URL (keeps the connection budget; security comes from FORCE RLS + transaction-local GUC).
3. **`AppSetting` — per-tenant.** Remove `AppSetting` from `GLOBAL_MODELS`; it becomes tenant-scoped. Excluded from Phase B, so it needs its own **additive `tenantId` migration first** (nullable → backfill `tenant_denago_cpt` → later NOT NULL), and settings-resolution moves to read the request tenant. Added as an early Phase C step.
4. **Second tenant — throwaway.** Prove isolation with a disposable test tenant in **preview only**; no real second dealer until isolation is proven in prod-monitor. The real activation flow (step 9) waits.

**Knock-on scope:** two extra pieces land before the uniqueness batch — (a) the per-tenant invoice counter (decision 1) and (b) the additive `AppSetting.tenantId` slice (decision 3). Both fold into the §6 sequence.

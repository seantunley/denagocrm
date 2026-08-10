# Pre-flip tenant audit — production, 2026-08-10

Read-only against `ep-patient-waterfall-asqpsfpe-pooler` (production). Session was
pinned with `SET default_transaction_read_only = on`; nothing here wrote anything.

Question being answered: **when we turn tenant enforcement on, what breaks?**

Two ways a row breaks at the flip:

1. it has a `tenantId` column but the value is `NULL` — the row becomes invisible
   to the workspace that created it, including to the person who is looking at it
   right now;
2. its table has no `tenantId` column at all — there is nothing to enforce, so the
   row stays visible to everybody, forever.

Both are below.

---

## Headline

| | |
|---|---|
| Tenants on production | **1** (`tenant_denago_cpt` — Denago Cape Town) |
| Tables carrying a `tenantId` column | 146 |
| Tables holding at least one **unowned** row | **19** |
| Unowned rows total | **1 607** |
| …of those, created **after** the 25 July backfill | **843** |
| Tables with **no `tenantId` column at all** | **20** |
| `SalesPipeline` / `PipelineStage` unowned rows | **0** |

The number that matters is **843**. The July migration
`20260725160000_tenant_governance_isolation` backfilled every legacy `NULL`. So
every one of those 843 rows was written by a code path that is **still running
today** and still producing unowned rows. This is not historical debt. It is an
active leak, and it has been leaking for a fortnight.

---

## 1. Unowned rows, by table

```
   1167 / 1171      ErrorLog
    313 / 491       AuditLog
     24 / 326       AuditEvent
     19 / 72        Communication
     14 / 61        Activity
     13 / 13        BackupRun
     11 / 25        QuoteItem
     10 / 11        JourneyEvent
      7 / 7         TimelinePin
      6 / 32        Conversation
      6 / 6         JourneyRun
      6 / 6         JourneyStepLog
      3 / 4         QuoteFee
      2 / 4         CompetitorBrief
      2 / 2         TestDriveBooking
      1 / 1         Dashboard
      1 / 19        Quote
      1 / 23        ResearchNote
      1 / 79        UserSession
```

### Still bleeding — written after the backfill

```
    752  ErrorLog
     24  AuditEvent
     12  AuditLog
     17  Communication
     11  Activity
     10  JourneyEvent
      6  JourneyRun
      5  Conversation
      2  CompetitorBrief
      1  TestDriveBooking
      1  Dashboard
      1  Quote
      1  ResearchNote
```

### What this confirms

**The P0 quote bug is not theoretical — it is in the data.** `Quote` 1,
`QuoteItem` 11, `QuoteFee` 3 unowned, with the parent quote created after the
backfill. That is precisely the defect PR #459 fixes: quote creation authorises a
scoped record, then enters a `basePrisma` transaction for advisory-locked
numbering, and `basePrisma` is the documented RLS bypass. Every row created inside
carried no tenant, children included — nested creates inherit nothing in Prisma.
We now have production rows proving the mechanism.

**`AuditEvent` 24 and `AuditLog` 12 are the worst of the batch, in kind if not in
count.** An audit trail that loses its owner at the flip is an audit trail the
workspace cannot read back. This codebase audits everything precisely so that
questions can be answered later; unowned audit rows answer nothing.

**`ErrorLog` 752 is the loudest but probably the least urgent.** Errors are
frequently raised where there is no session to attribute — a webhook, a cron, a
boot-time failure. That may be legitimately global. It needs a decision, not a
backfill: either `ErrorLog` is a global model and belongs in `GLOBAL_MODELS`, or
it is tenant data and the attribution path needs fixing. Right now it is neither,
which is the only genuinely wrong answer.

**Journeys are consistently unowned** — `JourneyEvent` 10/11, `JourneyRun` 6/6,
`JourneyStepLog` 6/6. Every row, not a subset. That is a module-level miss of the
same shape as the SalesPipeline one, and it matches the known `MarketingJourney*`
gap in item 2 below.

`TimelinePin` 7/7, `BackupRun` 13/13 — likewise, every row unowned.

---

## 2. Tables with no `tenantId` column at all

```
      0  MarketingJourney                 0  Passkey
      0  MarketingJourneyEnrollment       0  PdfmeTemplate
      0  MarketingJourneyStepRun         91  Permission
      0  MarketingJourneyVersion          1  PlatformAdmin
      1  Organization                     6  PlatformAdminSession
      2  OrganizationMembership           2  PushSubscription
      8  OtpChallenge                     0  SecurityRateLimit
      0  StockAttachment                  2  StockLocation
      1  StockMovement                    1  Tenant
      0  _ContactToTag                  205  _prisma_migrations
```

Sorting these by whether the absence is a decision or an oversight:

**Legitimately global — no action.** `Tenant`, `Permission`, `PlatformAdmin`,
`PlatformAdminSession`, `_prisma_migrations`. These are platform-level by
definition. `Passkey`, `OtpChallenge`, `SecurityRateLimit` are keyed by user or by
identifier and are defensible as global, but should be stated as a decision in
`GLOBAL_MODELS` rather than left implicit.

**Business data with no owner — needs a column.** `StockLocation` (2),
`StockMovement` (1), `StockAttachment` (0). Stock is shared-catalogue in the OEM
model but movements and locations are dealer-specific; this is exactly the
shared-stock/walled-data boundary and it currently has no boundary at all.

**Needs a decision before the flip.** `PushSubscription` (2) — a push subscription
with no tenant means a notification can be delivered to a device belonging to
another workspace. `Organization` (1) / `OrganizationMembership` (2) — these
overlap conceptually with `Tenant` and need to be reconciled, not merely stamped.

**Empty but structurally missing.** `MarketingJourney*` (all four, 0 rows),
`PdfmeTemplate`, `_ContactToTag`. Zero rows today, so no migration pain — which
makes this the cheapest possible moment to add the column. It will not stay cheap.

---

## 3. What this changes about PR #457

`SalesPipeline` and `PipelineStage` hold **zero** unowned rows on production.

That resolves the objection raised in review. The concern was correct in
principle: since the July backfill already claimed every legacy `NULL`, a `NULL`
appearing today could only have been written by the buggy `createPipeline` path,
and could therefore belong to a *different* tenant — so the compatibility rule
"`tenantId IS NULL` means the founding tenant" would silently hand one workspace's
pipeline to another.

The data says there are no such rows. So the fix is the clean one: **delete the
NULL-means-founding-tenant fallback outright.** No data migration, no guessing at
owners, no compatibility shim to carry forward. There is nothing to strand.

Caveat worth stating plainly: production has exactly one tenant, so no
cross-tenant misattribution can have happened *yet*. Every finding above is about
what happens the moment a second tenant exists — which is the whole point of doing
this before the flip rather than after.

---

## 3b. CORRECTION — the headline number was wrong

Added 2026-08-10, after the writers were investigated. **The "843 rows written by
code paths still running" figure above is misleading and should not be quoted.**
Most of those rows are correct by design.

Breaking the 843 down by what the writer actually turned out to be:

| rows | table | verdict |
|---:|---|---|
| 752 | `ErrorLog` | **by design** — see below |
| 24 | `AuditEvent` | correct — platform-admin and `system`-scope actions are legitimately unowned |
| 12 | `AuditLog` | correct — same |
| 10 | `JourneyEvent` | writer was **already fixed** on 2026-08-05; these rows predate the fix |
| 17 | `Communication` | genuinely defective |
| 11 | `Activity` | genuinely defective |
| 6 | `JourneyRun` | genuinely defective |
| 5 | `Conversation` | genuinely defective |
| 2 | `CompetitorBrief` | genuinely defective |
| 1 each | `TestDriveBooking`, `Dashboard`, `ResearchNote` | genuinely defective |

**So 44 rows came from genuinely broken writers, not 843.** All 44 writers are now
fixed across PRs #462 and `fix/tenant-stamp-audit-trail`.

Two more entries in the full 1,607 are likewise not debt: `BackupRun` 13/13 has an
**orphan column** in production that no Prisma model declares and nothing writes —
drift recorded in `20260806180000_rls_enforce_gap`, correctly left alone. And
`UserSession` 1/79 is a user with no `TenantMember` row, which is a provisioning
gap, not a stamping bug.

### `ErrorLog` is GLOBAL — decided

`tenantId` on `ErrorLog` is **attribution, not ownership**. Scoping it would make an
unscoped write **fail closed** under enforcement: the system log goes dark exactly
when the system is broken, and the record of why would be the record that could not
be written. Logging must never throw, so a tenant can never be a precondition for it.

The cost, stated plainly rather than hidden: a NULL row is readable from every
workspace's System Log, so an unattributed message or stack trace is visible
cross-tenant. That is bounded by `redactUrl` at the write and by the screen being
admin-only, and it is cheaper than losing the log.

`schema.prisma` had already made this decision; it simply was not written anywhere
the *guard* could be seen to make it, which is why this audit read 1,167 unowned
rows as undecided debt. It is now in `GLOBAL_MODELS`. **1,167 is the expected shape,
not a defect count.**

---

## 4. Why the module was skipped — the actual answer

The question was: how did an entire module get past a fine-toothed multi-tenancy
review? I had a theory that `SalesPipeline` lives in `prisma/governance.prisma`
rather than `schema.prisma`, and that the contract test only read the latter.

**That theory is wrong.** `tests/tenantSchemaContract.test.ts` already globs every
`prisma/*.prisma` file — folder mode, `schema: "./prisma"` — and that gap was
closed deliberately, with a comment explaining it. `PENDING` is empty. Every model
is either declared global or carries a `tenantId`.

The real answer is worse, and it is visible the moment the audit is laid next to
the test run. **The contract test passes 4/4. Simultaneously, in production:**

| model | declares `tenantId` | rows unowned |
|---|---|---|
| `Dashboard` | yes | **1 of 1** |
| `JourneyRun` | yes | **6 of 6** |
| `JourneyStepLog` | yes | **6 of 6** |
| `TestDriveBooking` | yes | **2 of 2** |
| `TimelinePin` | yes | **7 of 7** |
| `SalesPipeline` | yes | 0 — but no query ever filtered by it |

Every one of those models declares the column. The contract test checks that the
column is declared. Nothing in the repository checks that a single query ever
*writes* it or *filters* on it.

So the module was never skipped at the schema layer — the only layer anything
checked. A schema-shaped guardrail gives a schema-shaped guarantee and no runtime
guarantee at all. The review was fine-toothed against the wrong surface.

This is the same failure as the other two tenancy layers that also looked green
while doing nothing: RLS was enabled and FORCED on 120 tables while the app
connected as a `BYPASSRLS` role, and enforcement itself is dormant so scoped and
unscoped queries are indistinguishable in dev, in CI, and in single-tenant
production. Three layers, three green signals, no isolation.

The only instrument that can produce real evidence is a runtime test that seeds
two tenants and proves B's rows are unreachable from A — driven through the
**server actions**, because every defect actually shipped lived in the action
layer, not in the guard.

### Related drift found in passing

- `BackupRun` is declared **global** in `tenantGuard.ts`, with the comment "has no
  tenantId at all". Production has the column, holding 13 NULL rows. Code and
  database disagree about whether the column exists.
- `PipelineStage` in Postgres has `pipelineId`, `staleAfterDays`, `isClosed`,
  `closedStatus` and `defaultProbability`. The Prisma model declares none of them.
  Prisma therefore cannot read them, anything needing them must drop to raw SQL,
  and `prisma migrate dev` would propose dropping all five.

---

## 5. Recommended order of work

1. **Stop the bleed before backfilling anything.** Backfilling 1 607 rows while
   the writers still produce unowned ones just resets a counter. Fix the writers
   first — quotes (#459, in flight), then audit, activity, communication,
   journeys, dashboards, test-drive bookings.
2. **Decide `ErrorLog`.** Global model, or attributed. Either is defensible;
   leaving it ambiguous is not.
3. **Add `tenantId` to the missing-column tables while they are still empty** —
   `MarketingJourney*`, `PdfmeTemplate`, `StockAttachment`.
4. **Reconcile `Organization` vs `Tenant`** before either grows rows.
5. **Then backfill**, tenant by tenant, with the writers already fixed — on
   production that is unambiguous today because there is exactly one tenant.
6. **Only then flip enforcement**, with the two-tenant runtime harness green.

The single-tenant production database is what makes steps 1–5 safe to do now and
dangerous to do later. Every one of these is a five-minute fix today and a data
forensics exercise once a second tenant is writing rows.

# Before isolation is enforced, and before a second tenant

Written 2026-08-07, after the signing migration took production's deploys down
for three hours. Read this before turning on tenant enforcement or onboarding a
second workspace — the order of those two events matters more than either.

---

## The one-sentence version

`tenantEnforcing()` returns a hard-coded `false`, so **nothing stamps
`tenantId` on new rows**; every record created since the July backfill carries
`tenantId = NULL`, and the moment a second tenant exists those rows can no
longer be attributed to anyone by any rule.

---

## What is actually true today

| | |
|---|---|
| `tenantEnforcing()` | hard-coded `false` (`src/lib/tenantEnforcement.ts`) |
| Write stamping | **off** — `scopeArgs` returns early, so `stampCreate` never runs |
| Read scoping | off — same early return |
| `app.current_tenant` | **never set** — `db.ts` only sets it `if (tenantEnforcing())` |
| RLS policies | present and `FORCE`d on ~150 tables |
| RLS effect | **none** — the app connects as `neondb_owner`, which has `BYPASSRLS` |
| Composite tenant FKs | **live and enforced** — `(tenantId, parentId) → Parent(tenantId, id)` |

The last two rows are the trap. Row-level security is inert, so it forgives
everything; the composite foreign keys are real, and they forgive nothing. Any
code that stamps a child without stamping its parent fails immediately, and any
migration that demands `NOT NULL` fails on the accumulated NULL rows.

That combination has now caused two outages in one day:

- **`AuditLog_tenantId_contactId_fkey`** — the audit row took the *acting*
  tenant while the contact it described was unstamped. Creating a lead for a new
  person failed after the lead had already been written, so retrying produced
  duplicates.
- **`SignatureRequest_tenantId_documentId_fkey`** — the signing migration's
  backfill walked past two NULL parents to a stamped Contact and wrote that
  tenant onto a request whose Document was NULL. Because
  `scripts/apply-migrations.mjs` runs inside the Vercel **build** command, the
  failure took the whole deployment down, not just the migration. Production
  served three-hour-old code until it was fixed.

---

## Why the window closes when tenant #2 arrives

Right now every `tenantId IS NULL` row provably belongs to the single tenant,
because there is only one. That is what made
`20260805230000_signing_trust_platform`'s backfill safe: it stamps unstamped rows
to the founding tenant, in dependency order, and **refuses to run at all if more
than one tenant exists** — with two, which workspace an orphaned row belongs to
is not a question SQL can answer.

Every row created between now and enforcement is another row in that pile. Once a
second workspace is onboarded, the pile stops being attributable: a NULL
`Quote` created after that point could belong to either. There is no
after-the-fact rule; it becomes a manual reconstruction from timestamps and
audit history, or a write-off.

**So: turn on stamping before onboarding, not after.**

---

## What was deliberately deferred, and where

`20260805230000_signing_trust_platform` originally did two things this database
cannot yet support. Both are commented in the migration itself:

1. **`ALTER COLUMN "tenantId" SET NOT NULL`** on the six signing tables.
   Unkeepable: a signature request derives its tenant from its source quote, and
   quotes are created unstamped, so signing a newly created quote would be
   refused. Removed, with `tests/signingTrustPlatform.test.ts` asserting it stays
   removed until this document's checklist is done.

2. **A trigger refusing any request with no derivable tenant.** Its only fallback
   is `app.current_tenant`, which enforcement never sets. It now stamps when it
   can and leaves NULL when it cannot.

What was **kept**, because it is the rule that actually prevents contamination:
no stamping trigger may fall back to a *named* tenant, and a signing child may
never claim a different tenant from its request. Leaving `tenantId` NULL is not
a guess and cannot mis-file a record; asserting a tenant that is not provably the
row's own is exactly how one company's contract ends up filed under another's.

---

## The order to do it in

1. **Turn on write-time stamping, alone.** Reads stay unscoped. This is additive
   and cannot lock anyone out, because nothing is filtered — new rows simply
   start carrying their tenant. Today `scopeArgs` gates stamping and scoping on
   the same flag, so this needs them separated.
2. **Backfill again**, while there is still exactly one tenant, in the dependency
   order `pg_constraint` gives:
   `Contact → Vehicle/Lead → JobCard → Quote → Document → SignatureRequest`.
   Each `UPDATE` is checked as it runs, so a child stamped before its parent
   fails on the parent's composite key.
3. **Assert there are no NULLs left**, per table. This is the proof step and the
   only honest place for it.
4. **Add `NOT NULL` back**, on the signing tables and anywhere else it belongs.
   It succeeds only if step 3 really passed, which is why it goes last.
5. **Restore the refusing trigger** in the same change.
6. **Then** the RLS role cutover (`docs/RLS-ROLE-CUTOVER.md`) — repoint
   `DATABASE_URL` at the restricted, non-`BYPASSRLS` role, at which point the
   policies stop being decorative.
7. **Then** onboard a second tenant.

Steps 1–5 are one project. Step 6 is a separate one. Step 7 must not precede
either.

---

## Two things that will hide this from you

**CI applies migrations to an empty database.** Its own comment says so. An empty
database cannot contain a row whose parents disagree, so a migration that fails
on real data passes CI cleanly. `scripts/test-signing-upgrade.ts` exists to close
this and now seeds the exact shape that broke production — an unstamped
`Document`, a stamped `Contact`, one request pointing at both. Extend it rather
than trusting a green run.

**CI does not run `next build`.** It is skipped deliberately, on the grounds that
Vercel builds every push anyway. The consequence is that the deploy is unverified
until it runs for real, and because migrations execute *inside* the build
command, a data-dependent migration failure fails the whole deployment. **A green
CI run does not mean the application deployed.** Check the deployment itself:

```
gh api repos/:owner/:repo/deployments --jq '.[0:3][] | "\(.created_at) \(.environment) \(.sha[0:8])"'
gh api repos/:owner/:repo/deployments/<id>/statuses --jq '.[0].state'
```

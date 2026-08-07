# Making Row Level Security load-bearing

**Status:** the code and scripts are ready. The cutover itself is four steps on the Neon console and one environment variable, and it has not been done.

---

## The problem, stated exactly

Migration `20260727130000_rls_enforce` enabled Row Level Security on 120 tables and added `FORCE ROW LEVEL SECURITY` to each. That work is correct.

It is also, right now, doing nothing at all.

The application connects to Neon as `neondb_owner`. That role carries the Postgres role attribute **`BYPASSRLS`**. A role with `BYPASSRLS` is exempt from every row-level policy on every table, and `FORCE` does not change that — `FORCE` defeats the *table owner's* exemption, which is a different exemption with a similar name.

Proven on production, read-only, on 2026-08-06:

```sql
SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = current_user;
--  neondb_owner | t

SHOW app.current_tenant;      -- unset
SELECT count(*) FROM "Contact";
--  17
```

With no tenant set, the policy in the migration evaluates to false for every row. The correct answer is `0`. We got `17`.

So today tenant isolation rests entirely on the application layer — the `tenantId` filters and the `withRlsScope` GUC. That layer is real and it is tested. But it is one layer, and RLS was added precisely so that it would not be the only one. A single query that forgets a filter is currently a cross-tenant leak; after this cutover it is an empty result.

---

## What changes

One thing: **the application connects as a role that does not have `BYPASSRLS`.**

Nothing about the schema changes. No policy is edited. No migration runs. The rollback is to put the old connection string back.

| | before | after |
|---|---|---|
| `DATABASE_URL` (app, pooled) | `neondb_owner` | **`crm_app`** |
| `DATABASE_URL_UNPOOLED` (migrations, direct) | `neondb_owner` | `neondb_owner` — unchanged |

`crm_app` gets `SELECT, INSERT, UPDATE, DELETE` and nothing else. No DDL, no `TRUNCATE`, no ownership. That matters: a role that can `ALTER TABLE` can drop the policy that isolates tenants, and a role that can `TRUNCATE` can empty another tenant's table without a single row-level `DELETE` being evaluated.

---

## Before you start

Both of these are already true, but check rather than assume — they are what the rest of this depends on.

**`DATABASE_URL_UNPOOLED` must be set on Vercel, to the owner's direct connection string.** `scripts/apply-migrations.mjs` falls back to `DATABASE_URL` when it is missing. That fallback is harmless today and becomes a broken deploy the moment `DATABASE_URL` is the restricted role. There is now a guard that refuses to migrate as a role without DDL rather than failing part-way through a migration script, but the guard is a net, not a plan.

**`basePrisma` must be what the trusted paths use.** Login, the platform-admin console, cron jobs and the brand lookup all run before a tenant scope exists, and they work by setting `app.bypass_rls='on'` — which is a *GUC*, not a role attribute, and keeps working under `crm_app`. `src/lib/db.ts` handles this for model operations and for all four raw methods. If something bypasses by connecting as the owner instead, it will break at step 5 rather than at step 3, so it is worth grepping first.

---

## The cutover

### 1. Create the role in the Neon console

**Neon → your project → Roles → New Role.** Name it `crm_app`. Copy the password Neon generates.

Create it in the console rather than with `CREATE ROLE` over SQL: a console-created role is registered with Neon's connection proxy, which is what makes it usable on the **pooled** endpoint that `DATABASE_URL` points at. `prisma/rls/app-role.sql` will create the role if it is absent, but that path is for self-hosted Postgres and for the disposable database in CI.

### 2. Grant it

Run `prisma/rls/app-role.sql` as `neondb_owner` — Neon SQL Editor, or `psql "$DATABASE_URL_UNPOOLED" -f prisma/rls/app-role.sql`.

It is idempotent, it re-asserts `NOSUPERUSER NOBYPASSRLS` on a role that already exists, and it raises an exception at the end if the role can still bypass. It changes nothing about the running application, because nothing connects as `crm_app` until step 4.

The line that matters most is the one that is easy to skip:

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crm_app;
```

`GRANT ON ALL TABLES` is a loop over the tables that exist at that instant. It is not a rule. Without the default-privilege rule above, the next migration that adds a table creates it unreadable by the application, and the deploy that ships it takes that feature down with `permission denied for table X`. CI now proves this line works: `npm run test:rls-restricted` runs this exact file, creates a table afterwards, and asserts the role can still read it.

### 3. Audit, before changing anything

```bash
DATABASE_URL="<owner connection string>" npm run check:rls-role
```

Read-only. Every statement is a `SELECT`. It reports:

- whether `crm_app` exists and genuinely cannot bypass;
- every table missing a grant — *these are the tables that would 500 after the cutover*;
- every table with RLS enabled and **no policy** — those return zero rows to a non-bypassing role, which is an outage that is invisible while the owner is connected;
- whether future tables are covered;
- whether anything has `TRUNCATE`.

**Do not continue until this is green.** This is the whole point of doing it in this order: every way the cutover could break the site is visible here, while production is still connecting as the owner and nothing has changed.

### 4. Prove it, as the role, before Vercel sees it

From your own shell — not CI, not a deploy:

```bash
DATABASE_URL="<crm_app POOLED connection string>" npm run check:rls-role
```

Now section 5 runs, and it is the only check that cannot be satisfied by configuration that merely looks right:

```
ok   no tenant set → "Contact" returns 0 rows. RLS is enforcing.
ok   app.bypass_rls='on' → 17 rows. The trusted path still works.
```

Both lines matter. The first is isolation. The second is that login and the admin console still work — a run where the first passes and the second does not is a site that is secure and completely unusable.

### 5. Cut over

Vercel → Settings → Environment Variables → **Production**:

- `DATABASE_URL` → `crm_app`'s **pooled** connection string
- `DATABASE_URL_UNPOOLED` → leave as `neondb_owner`

Redeploy. Then, in this order:

1. **Log in.** Pre-auth, `basePrisma`, no tenant scope. If this fails, roll back — do not debug it live.
2. **Open a contact, a lead, a quote.** Tenant-scoped reads through the GUC.
3. **Save something.** Writes go through the same policy as reads, via `WITH CHECK`.
4. **Open the platform-admin console.** Cross-tenant reads on the bypass path.
5. **Print a signed quote.** Touches blobs, the company profile and `SignatureRequest` in one request.

### 6. Watch the first migration

The next deploy that carries a migration is the first real test of step 2's default privileges. `npm run check:rls-role` against the owner after it lands will say so in one line.

---

## Rolling back

Put the old `DATABASE_URL` back and redeploy. That is the entire rollback.

It works from any point, at any time, because nothing else changed: no schema, no policies, no data. The role keeps existing and keeps its grants, so a second attempt starts at step 3 rather than step 1.

---

## What this does not fix

**RLS is a second layer, not the first one.** Every `tenantId` filter in the application still matters. RLS turns "forgot a filter" from a cross-tenant leak into an empty result — it does not make the filters optional, and an empty result where a user expected data is still a bug.

**`basePrisma` is a real bypass and it is meant to be.** Anything on that path — login, cron, the platform console, the pre-auth brand lookup — is exempt by design and is only as safe as its own guards. This cutover does not narrow it. Auditing what runs on `basePrisma` is separate work.

**The disposable CI database is not Neon.** `npm run test:rls-restricted` creates its own `NOSUPERUSER NOBYPASSRLS` role and drives the real scoped client through it, which is a genuine proof of the policies and the grants. It is not a proof of Neon's pooler accepting the role, which is why step 4 exists and is done by hand.

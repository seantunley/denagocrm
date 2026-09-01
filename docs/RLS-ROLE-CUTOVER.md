# Making Row Level Security load-bearing

**Status: THE CUTOVER IS DONE, and verified live on 2026-09-01.** A read-only
census of `pg_stat_activity` showed every Vercel connection running as
`crm_app` through the pooler, `rolbypassrls = false` — the only `neondb_owner`
session was the audit script taking the census. Row Level Security is
load-bearing in production. See
[Post-cutover verification](#post-cutover-verification-2026-09-01) for the full
audit, and keep running it after schema-bearing deploys: with a non-bypassing
role live, the failure mode has inverted — a new table shipped without grants or
policy no longer *leaks*, it *breaks*, as `42501` or a silently empty screen.

Everything below is kept as written, because it is the reference for how the
cutover was designed, what it depends on, and how to roll it back.

Original status when this document was the plan: the code and scripts were
ready, the role proven end to end against a real PostgreSQL — see
[What is proven](#what-is-proven) — and production still connected as
`neondb_owner`.

---

## What is proven

The two-tenant harness (`npm run test:tenant-isolation`) now drives the entire application through a `NOSUPERUSER NOBYPASSRLS` role, created by executing **this repository's own `prisma/rls/app-role.sql`** — the same file step 2 below runs on production. Before that it connected as the scratch server's bootstrap superuser, which reproduced production's exemption exactly and made the RLS half of the boundary untestable.

**The canary flipped.**

| | enforced run |
|---|---|
| owner / superuser (before) | 48 passed, **1 failed**, 25 not covered |
| restricted role (after) | **49 passed, 0 failed**, 25 not covered |

The one failure was `TimelinePin [READ]`, and it flipped **with no application code change** — no edit to `getTimelinePins`, to `src/lib/db.ts`, or to the probe. That check exists because `getTimelinePins` is `prisma.$queryRaw`: a Prisma query extension cannot rewrite raw SQL, so RLS was the only boundary left, and RLS does nothing for a role carrying `BYPASSRLS`. It was the documented, allowlisted proof that this cutover was the remaining blocker. `scripts/harness/acknowledged.ts` is now **empty**, and its staleness rule is what forced the entry to be deleted rather than left to rot.

Also green under the same role: `npm run test:rls-restricted` (14/14), which additionally proves the `ALTER DEFAULT PRIVILEGES` line by creating a table *after* the grants and reading it back.

**What this does not prove** is the cutover. It proves the policies, the grants and the application's `SET LOCAL` are correct under a non-bypassing role, on a database built from this repository's migrations. Production is a different database with drift this repository does not describe, and Neon's connection pooler is not in the harness at all. That is what steps 3 and 4 are for.

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

**Nothing in `src/` may build its own `PrismaClient`.** Checked on 2026-08-11: there is exactly one, inside `src/lib/db.ts`, and both exported clients are built from it. A second one would set no GUC at all — under `crm_app` every query it issues returns zero rows or fails `42501`, and under the owner it works perfectly, so it ships green. Re-run before cutting over:

```bash
grep -rn "new PrismaClient" src/       # expect exactly one hit: src/lib/db.ts
```

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
DATABASE_URL="<owner UNPOOLED connection string>" npm run check:rls-role
```

Read-only. Every statement is a `SELECT` (connected as the owner, section 5 — the only part that issues a `SET` — does not run at all). Use the **unpooled** string: a `SET` on the pooled endpoint leaks session state across connections, and the habit is worth keeping even where nothing is set. It reports:

- whether `crm_app` exists and genuinely cannot bypass;
- every table missing a grant — *these are the tables that would 500 after the cutover*;
- every table with RLS enabled and **no policy** — those return zero rows to a non-bypassing role, which is an outage that is invisible while the owner is connected;
- every policy restricted `TO` a role that is not `crm_app` — a policy that exists is not necessarily a policy that *applies*, and one added by hand `TO neondb_owner` leaves the table denying everything while every other check stays green;
- whether future tables are covered;
- whether anything has `TRUNCATE`.

**Do not continue until this is green.** This is the whole point of doing it in this order: every way the cutover could break the site is visible here, while production is still connecting as the owner and nothing has changed.

#### The read-only verification queries

`check:rls-role` runs these for you. They are written out because a cutover is a
thing done at a SQL prompt at an awkward hour, and because the answer to "is this
safe yet" should not require running a repository checkout.

Paste into the Neon SQL Editor as `neondb_owner`. Every one is a `SELECT`.

```sql
-- 1. WHO BYPASSES? The whole problem, in one row per role.
--    Expect: neondb_owner t, crm_app f. If crm_app is `t`, stop — nothing else matters.
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin
FROM pg_roles WHERE rolname IN ('neondb_owner', 'crm_app');

-- 2. RLS ENABLED WITH NO POLICY — an outage that is invisible from the owner.
--    RLS on with no policy denies EVERY row. Expect: 0 rows.
--    NOTE: not filtered to tables with a tenantId. A table with RLS on, no policy
--    and no tenantId is exactly as broken, and is the case a tenant-only filter
--    would miss.
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
  AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid);

-- 3. POLICIES THAT WOULD NOT APPLY TO crm_app. `0` in polroles means PUBLIC.
--    Expect: 0 rows.
SELECT c.relname, p.polname,
       ARRAY(SELECT pg_get_userbyid(x) FROM unnest(p.polroles) x) AS roles
FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND NOT (0 = ANY(p.polroles));

-- 4. TABLES crm_app CANNOT USE — every one is a `permission denied` after the
--    cutover. Expect: 0 rows. (Run AFTER step 2 has granted; before that it
--    returns everything, which is the correct answer.)
SELECT c.relname,
       array_to_string(ARRAY(
         SELECT v FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) v
         WHERE NOT has_table_privilege('crm_app', c.oid, v)), ',') AS missing
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'
  AND NOT (has_table_privilege('crm_app', c.oid, 'SELECT')
       AND has_table_privilege('crm_app', c.oid, 'INSERT')
       AND has_table_privilege('crm_app', c.oid, 'UPDATE')
       AND has_table_privilege('crm_app', c.oid, 'DELETE'));

-- 5. TRUNCATE anywhere. TRUNCATE ignores row-level DELETE policies outright, so
--    a tenant-scoped role holding it can empty another tenant's table.
--    Expect: 0 rows.
SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND has_table_privilege('crm_app', c.oid, 'TRUNCATE');

-- 6. THE NEXT MIGRATION. `GRANT ON ALL TABLES` is a loop over what exists, not a
--    rule. Expect: at least one row, owner = neondb_owner, acl mentioning crm_app.
SELECT pg_get_userbyid(d.defaclrole) AS owner, d.defaclobjtype,
       array_to_string(d.defaclacl::text[], ' ') AS acl
FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
WHERE n.nspname = 'public';

-- 7. ANYTHING NOT OWNED BY neondb_owner. The default-privilege rule in step 2 is
--    attached to the CREATING role, so an object created by a different one is
--    outside it. Expect: 0 rows.
SELECT c.relname, c.relkind, pg_get_userbyid(c.relowner) AS owner
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r','S','v','m')
  AND pg_get_userbyid(c.relowner) <> 'neondb_owner';
```

#### What those queries answered on production, 2026-08-11

Run read-only as `neondb_owner` over `DATABASE_URL_UNPOOLED`. **Nothing was written.**

| question | answer |
|---|---|
| tables in `public` | 166 — 153 carry a `tenantId` |
| RLS enabled **and** `FORCE`'d | 153 / 153. None enabled-but-not-forced |
| **RLS enabled with no policy** | **0** — nothing is unpoliced |
| **policies that exclude `crm_app`** | **0** — every policy is `TO PUBLIC` |
| tables with **no RLS at all** | 13 (below) |
| views / materialised views | 0 |
| sequences | 1 — covered by `GRANT USAGE, SELECT ON ALL SEQUENCES` |
| objects not owned by `neondb_owner` | 0 — the default-privilege rule covers everything |
| functions in `public` | 66, **all** `EXECUTE` to `PUBLIC` (default ACL) — no `GRANT EXECUTE` needed |
| `SECURITY DEFINER` functions owned by `neondb_owner` | 0 — see [Watch](#what-to-watch-immediately-after) |
| schemas | `public` only |
| `crm_app` | does not exist yet |

The 13 tables with no RLS, and why that is not a blocker for this cutover:

- **`TenantMember`** — the only one carrying a `tenantId`. Deliberately excluded: it answers "which tenant does this user belong to?" *before* a scope exists, so a `tenantId = current_tenant` policy is circular, and it would silently defeat `addTenantMembership`'s one-user-one-tenant guard, which queries `NOT: { tenantId }`. Recorded in `NO_POLICY_BY_DESIGN` in both `check-rls-role.ts` and `tests/rlsPolicyCoverage.test.ts`.
- **`Tenant`, `Permission`, `PlatformAdmin`, `PlatformAdminSession`, `OtpChallenge`, `Passkey`, `SecurityRateLimit`, `_prisma_migrations`** — global by design. No `tenantId`, nothing for a row policy to key on.
- **`Organization`, `OrganizationMembership`, `PushSubscription`, `_ContactToTag`** — no `tenantId` either, but these hold rows that plainly belong to *somebody*. RLS has nothing to say about them because the column does not exist; giving them a tenant slice is a **schema** change, not a privilege one, and it is separate work. **This cutover does not make them worse** — they are exactly as exposed after it as before.

The earlier finding of *"27 tables with no RLS"* is closed: `20260806180000_rls_enforce_gap` covered the tenant-scoped ones, and the live catalog now shows every table carrying a `tenantId` behind an enabled, forced, policied RLS — except `TenantMember`, above.

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

## What to watch immediately after

Everything below fails **closed** — as an empty screen or a `42501`, not as a leak. That is the good news and also the difficulty: a page that renders with nothing on it does not look like an incident.

**In the logs, for the first hour, grep for these three.** Each has one cause.

| what you see | what it means |
|---|---|
| `42501 permission denied for table X` | `X` was created after step 2's `GRANT ON ALL TABLES` **and** outside its `ALTER DEFAULT PRIVILEGES` rule — i.e. created by a role other than `neondb_owner`. Re-run `prisma/rls/app-role.sql`; then find out what created it. |
| `42501 new row violates row-level security policy for table X` | a write reached the database with no `app.current_tenant` and no `app.bypass_rls`. Means a client that is not the one in `src/lib/db.ts` — a stray `new PrismaClient`, or a connection opened by a script that is on the request path when it should not be. |
| a screen that renders with **zero rows** where there is data | the read half of the same thing. Worse than the error, because nothing is thrown. This is the one to check by eye rather than by log. |

**Check by hand, in this order** (the same list as step 5, repeated here because it is the post-deploy list too): log in → open a contact, a lead, a quote → save something → open the platform-admin console → print a signed quote.

**Two specific things this cutover changes that no test covers:**

1. **Trigger bodies now run as `crm_app`.** All 30 `neondb_owner` functions in `public` are `SECURITY INVOKER` (0 are `SECURITY DEFINER`), so a trigger that writes to another table does that write **as the connected role and subject to RLS**. The harness exercises the common ones — quotes, job cards, leads, activities — and they pass. The **signing** triggers (`signing_chain_event`, `signing_enqueue_*`, `signing_stamp_*_tenant`, `signing_evidence_immutable`) are the least covered, because `test:signing-upgrade` does not run in this environment. Printing and signing a document is therefore the highest-value manual check on the list, not the last one.
2. **Neon's pooler must accept the role.** The harness runs against a plain PostgreSQL with no pooler in front of it. A role created with `CREATE ROLE` over SQL rather than in the Neon console may not be registered with Neon's connection proxy, and the failure mode is that the **pooled** endpoint refuses it while the direct one works. This is exactly why step 1 says to create it in the console and step 4 says to connect as it **by hand, from your own shell, before Vercel sees it**.

**Cron and the platform console are on the bypass path and are not exempt from being checked.** They work by setting `app.bypass_rls='on'`, which is a GUC and keeps working under `crm_app` — but "keeps working" is a claim, and the first scheduled run after the cutover is when it stops being one. Check the next cron run completed.

**Keep `npm run check:rls-role` in your hand for a week.** Run it as the owner after every deploy that carries a migration. It is read-only and takes seconds, and question 6 of the query set is the one that goes wrong quietly.

---

## What breaks under the restricted role

Found by running every DB-backed suite against the same database twice — once as the owner, once as `crm_app` — and taking the delta. **None of these were fixed by widening the role's privileges.** The role has `SELECT, INSERT, UPDATE, DELETE` and nothing else; a failure here is information about the cutover, and granting it away would have thrown that information out.

### Application code: nothing

`src/` contains exactly **one** `new PrismaClient` — the one inside `src/lib/db.ts` that both exported clients are built from. Every query the application issues therefore goes through `withRlsScope` (model ops) or the Layer 2b raw-method patch (`$queryRaw` and friends), and both set a GUC before anything else runs. There is no second client, no DDL, and no `TRUNCATE` anywhere in `src/`.

That is the single most important result in this document, and it is the reason the cutover is a one-variable change rather than a project. **It is also the thing most likely to stop being true.** A new `new PrismaClient(...)` anywhere in `src/` is a client with no GUC injection: under `crm_app` every one of its queries returns zero rows or fails `42501`, and under the owner it works perfectly, so it ships green.

### Test and tooling code: three, all expected

| suite | as owner | as `crm_app` | cause |
|---|---|---|---|
| `test:security` | pass | **`42501` new row violates RLS policy for `"User"`** | `const prisma = new PrismaClient()` — `scripts/test-security.ts:18`. A bare client sets no GUC, so RLS denies it. |
| `test:rbac` | pass | **`42501` new row violates RLS policy for `"User"`** | same shape — `scripts/test-rbac.ts:18`. |
| `test:tenant-e2e` | pass | **`42501` permission denied to create role** | `CREATE ROLE` at `scripts/test-tenant-e2e.ts:77`. The suite builds its *own* `NOBYPASSRLS` role to prove isolation, so it needs an owner connection by construction. Correct behaviour: a role that can `CREATE ROLE` can create one that bypasses. |

The first two are the *test-side* instance of the risk described above, and they are worth leaving as they are: they are a live demonstration that a bare `PrismaClient` does not work under this role, sitting in the repository where the next person to write one will meet it.

All three are **tooling that runs as the owner anyway.** Migrations, `apply-migrations.mjs`, `create-tenant.ts`, `create-platform-admin.ts`, `export-data.ts`, `import-data.ts` and the DB-backed suites all connect via `DATABASE_URL_UNPOOLED` or an explicit owner string, exactly as they do today. None is on the request path.

Twelve suites — including `test:integrity`, `test:tenant-guard`, `test:platform-admins`, `test:receipt-isolation`, `test:migration-session`, `test:dm-binding`, `test:inbox-selection`, `test:staff-reply` and `test:meta-echo` — pass **identically** under both roles.

### Not caused by the role

`test:signing-upgrade` (`spawnSync npx.cmd EINVAL`, a Windows-only spawn problem) and `verify:governance` fail the same way under **both** roles. They are pre-existing and unrelated; they are listed only so the delta above is not read as five failures.

---

## Rolling back

**Put the old `DATABASE_URL` back — the `neondb_owner` pooled string — and redeploy. That is the entire rollback.**

```
Vercel → Settings → Environment Variables → Production
  DATABASE_URL  ←  the neondb_owner pooled connection string
  (DATABASE_URL_UNPOOLED is already neondb_owner and does not change)
Redeploy.
```

Keep that string somewhere you can reach without the Vercel UI before you start step 5. It is the whole recovery plan and it is one line.

It works **from any point, at any time**, because nothing else changed:

- **no schema change** — not one `ALTER TABLE`;
- **no policy change** — the policies have been installed since `20260727130000_rls_enforce`; this cutover only makes them evaluate;
- **no data change**;
- **no application change** — `TENANT_ENFORCEMENT` is a separate switch and this does not touch it.

The role keeps existing and keeps its grants, so a second attempt starts at step 3, not step 1. There is nothing to un-create and nothing to clean up. Rolling back does not "disable RLS" — RLS returns to being enabled, forced, and inert, which is exactly what production has today.

**Do not roll back by granting `BYPASSRLS` to `crm_app`.** It looks like the faster fix and it is the worst possible outcome: the site comes back, every check in this document still passes, and the boundary is silently gone with nothing pointing at it. If the app must bypass, it does so through `app.bypass_rls` — in the application, in a diff, revertible in one deploy. `prisma/rls/app-role.sql` re-asserts `NOBYPASSRLS` every time it runs partly to undo this if somebody does it at 2am.

---

## What this does not fix

**RLS is a second layer, not the first one.** Every `tenantId` filter in the application still matters. RLS turns "forgot a filter" from a cross-tenant leak into an empty result — it does not make the filters optional, and an empty result where a user expected data is still a bug.

**`basePrisma` is a real bypass and it is meant to be.** Anything on that path — login, cron, the platform console, the pre-auth brand lookup — is exempt by design and is only as safe as its own guards. This cutover does not narrow it. Auditing what runs on `basePrisma` is separate work.

**The disposable CI database is not Neon.** `npm run test:rls-restricted` creates its own `NOSUPERUSER NOBYPASSRLS` role and drives the real scoped client through it, and `npm run test:tenant-isolation` now drives the whole application through one. Both are genuine proofs of the policies and the grants. Neither is a proof of Neon's pooler accepting the role, which is why step 4 exists and is done by hand.

**The CI database is not production either.** It is built from `prisma/migrations`, and production has drift that no migration describes — that is what the preview-migrations incident recorded and what `20260806180000_rls_enforce_gap` had to be guarded on a *column* existing rather than a table. So the harness proves the policies are right; only step 3, run against production, proves they are right *there*. Run it, do not assume it.

**The tables with no `tenantId` are untouched.** `Organization`, `OrganizationMembership`, `PushSubscription` and `_ContactToTag` hold rows that belong to somebody and have no column for a policy to key on. This cutover leaves them exactly as exposed as they are today — no better, no worse. Giving them a tenant slice is a schema change and separate work.

**`TENANT_ENFORCEMENT` is still off, and this does not turn it on.** The two are independent switches and they protect different things: enforcement scopes Prisma *model* operations in the application, RLS scopes *rows* in the database, and raw SQL is only covered by the second. The pre-flip gate is now green with an empty allowlist, which means enforcement is safe to flip *from the harness's point of view* — but that is a second decision, with its own deploy, and it should not ride along with this one.

---

## Post-cutover verification (2026-09-01)

Run read-only as `neondb_owner` over `DATABASE_URL_UNPOOLED`, three weeks after
the 2026-08-11 pre-cutover audit and after the cutover itself.

**Who is connected** (`pg_stat_activity`): 5 pooled connections as **`crm_app`**
(`application_name: pgbouncer` — Vercel), 1 direct as `neondb_owner` — the audit
script itself. `crm_app` is `NOSUPERUSER NOBYPASSRLS`, `neondb_owner` retains
`BYPASSRLS` for migrations, as designed.

**`npm run check:rls-role`: all checks passed.**

| question | 2026-08-11 (pre) | 2026-09-01 (post) |
|---|---|---|
| tables in `public` | 166 | **175** |
| carrying a `tenantId` | 153 | **162** |
| tenant tables RLS enabled + FORCE'd | all | all |
| RLS enabled with no policy | 0 | 0 |
| policies excluding `crm_app` | 0 | 0 |
| tables missing a grant | — (role absent) | **0** |
| TRUNCATE anywhere | — | 0 |
| future tables covered (default ACL) | yes | yes |

The nine tables added between the audits — the guided-checklist family,
`BotKnowledgeEntry`, `BotFlowRoute`, `BotFlowEvaluation`, the X social-inbox and
attention-centre work — were all created by `neondb_owner` through the normal
migration path, so the `ALTER DEFAULT PRIVILEGES` rule granted every one of
them automatically and their `tenantId` policies rode in with their migrations.
Step 2's most-easily-skipped line has now carried three weeks of real schema
churn without a single manual re-grant. That is the mechanism working, not luck
— but it holds only while migrations run as `neondb_owner`, which is why
`DATABASE_URL_UNPOOLED` must stay the owner.

The 11 tables with no `tenantId` are the known global-by-design list. Unchanged,
and unchanged in exposure.

**Standing instruction:** after any deploy that carries a migration, re-run
`check:rls-role` as the owner. Under a live non-bypassing role, the audit is no
longer preparation — it is the difference between knowing a new table works and
finding out from a customer's empty screen.

# Preview deployments must not share the production database

## What went wrong

`vercel.json` runs the migration runner inside the build command:

```json
"buildCommand": "prisma generate --schema ./prisma && node scripts/apply-migrations.mjs && next build"
```

That runs for **every** deployment, previews included, against whatever
`DATABASE_URL` the environment provides. Preview deployments were pointed at the
production database, so every open pull request migrated production — days or
weeks before the corresponding code was merged.

It stayed invisible while the migrations happened to be additive. It stopped
being invisible on 27 July 2026, when `20260727190000_appsetting_pk_composite`
moved `AppSetting`'s primary key from `key` to `id` with a composite unique on
`(tenantId, key)`. The deployed code still declared `key` as the `@id`, so Prisma
kept emitting `ON CONFLICT (key)` — which then matched no constraint:

```
42P10: there is no unique or exclusion constraint matching the ON CONFLICT specification
```

Every `appSetting.upsert` failed: saving any setting, module toggles, stock
labels and statuses, Google Reviews sync, the backup cron, the AI health check.
It ran for a day and a half before anyone connected the symptoms.

Two other consequences of the same cause:

- Composite tenant foreign keys (`20260727140000_composite_tenant_fks`) went live
  while the lead code still wrote rows without a `tenantId` — surfacing as a run
  of apparently unrelated lead/contact foreign-key bugs.
- `20260728140000_tenant_member_single_tenant` was applied, then withdrawn from
  the branch. It is permanently recorded in production's `_prisma_migrations`
  and its unique index still exists on a table whose schema says the column is
  deliberately not unique.

## The three defences

**1. The runner refuses.** `previewMayMigrate` in `scripts/apply-migrations.mjs`
skips migrations on any deployment where `VERCEL_ENV=preview` unless
`PREVIEW_DB_ISOLATED=1` declares that the preview owns its database. It skips
rather than fails: a preview running against an already-correct schema is fine,
whereas corrupting the live database is not. Covered by
`tests/migrationIntegrity.test.ts`.

**2. A database per pull request.** `.github/workflows/preview-database.yml`
creates a Neon branch named `preview-pr-<number>` when a pull request opens, and
deletes it when the pull request closes — merged or not. A third job sweeps
orphans whose close event was missed, so the guarantee does not rest on a single
webhook delivery. The delete step refuses to touch a default or protected branch.

**3. Isolation must be asserted, never inferred.** There is no reliable way to
tell a scratch database from production by its connection string, and guessing
wrong is the failure being prevented. `PREVIEW_DB_ISOLATED=1` is a deliberate
manual assertion.

## Setup required (one time, in the dashboards)

Neither of these can be set from the repository.

**GitHub → Settings → Secrets and variables → Actions**

| Secret | Where to find it |
| --- | --- |
| `NEON_API_KEY` | Neon → Account settings → API keys |
| `NEON_PROJECT_ID` | Neon → Project settings → General |

Until both exist the workflow no-ops with a notice rather than failing, so a
missing secret never turns pull requests red.

**Vercel → Project → Settings → Environment Variables**, scoped to **Preview**
only:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | the preview branch's pooled connection string |
| `DATABASE_URL_UNPOOLED` | the preview branch's direct connection string |
| `PREVIEW_DB_ISOLATED` | `1` |

Set `PREVIEW_DB_ISOLATED=1` **last** — only once preview genuinely points at its
own branch. Setting it while previews still target production re-opens the exact
hole this closes.

The simplest way to wire the connection strings is Vercel's Neon integration,
which injects the per-branch URLs automatically. Doing it by hand works too, but
then the URLs are per-project rather than per-pull-request, so use a single
long-lived `preview` branch instead of the per-PR branches above.

## Verifying it worked

After the next preview deploy, its build log should contain:

```
⚠ PREVIEW DEPLOYMENT — SKIPPING MIGRATIONS.
```

…until `PREVIEW_DB_ISOLATED=1` is set, after which it should apply migrations and
name a **preview** host, never the production one. To confirm production is no
longer being migrated ahead of `main`, compare the two:

```sql
SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY finished_at DESC LIMIT 10;
```

Nothing in that list should be a migration absent from `main`.

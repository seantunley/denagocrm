# DenagoCRM

A multi-workspace CRM and EV service platform. It runs Denago Cape Town's sales, workshop and customer operations at **crm.denagocpt.co.za**. Each workspace (tenant) has its own staff, customers, branding and web address, and cannot see any other workspace's data.

Built with Next.js 16 (App Router, server actions), React 19, TypeScript, Prisma 6 on PostgreSQL (Neon), Tailwind CSS 4, and Vercel (hosting, cron and Blob storage).

> Working in this repo with an AI agent? Read [AGENTS.md](AGENTS.md) first. This Next.js version differs from older docs, and fixes for an open PR target `main`.

---

## What it does

Features are grouped into modules that each workspace can switch on or off. The registry is [src/lib/modules/registry.ts](src/lib/modules/registry.ts).

| Module | What's in it |
| --- | --- |
| **CRM core** (always on) | Home and Today; leads pipeline (kanban with stage rules and a "needs attention" list); contacts; activities and calendar; quotes and the deal workspace (one page per deal: quote, vehicle, stock, deposit and delivery readiness); documents; reports, dashboards, targets and forecast; customer health; birthdays; data quality |
| **Social inbox** | Shared WhatsApp / Messenger / Instagram inbox, the Messages phone app, an Outlook-style email composer, and IMAP inbound email on the timeline |
| **Help desk** | Customer cases and ticketing |
| **Marketing** | Campaigns, audiences, templates and email designer, surveys and insights, referrals, and **Journeys**, the single automation engine (triggers, waits, branches, sends) |
| **Automation & AI** | **DAX**, the CRM assistant ("Ask the CRM" on the web, also on WhatsApp, with voice, quotes and proactive briefs); the chatbot and its knowledge base; the visual flow builder; competitor watch |
| **Automotive / Workshop** | Vehicles and fleets, test drives with indemnity signing, job cards, parts, the workshop calendar, service-due, warranty claims, battery health, and deliveries |
| **Stock & inventory** | Stock units, purchase orders and goods receipts |
| **Customer portal** | Customer self-service: documents, profile and support |

These are available to every workspace:
- **In-house e-signing** (signatures, signing workflows, sealed PDFs with optional trusted timestamps);
- **Document Studio** for quote, statement and email layouts;
- **Audit log** and **Repairs** (governance).

The **platform console** (`/platform`) handles workspaces, domains, plans, usage and billing.

---

## How it fits together

- **Multi-tenancy:**
  - It is a shared database with row-level security. Every tenant-owned row carries `tenantId`.
  - `TENANT_ENFORCEMENT=enforce` (live since 2026-08-12) makes the app's guarded Prisma client fail closed without a workspace scope.
  - In production the app connects as the `crm_app` role (`APP_DATABASE_URL`), which cannot bypass RLS. Any table without a policy is unreadable.
  - Background work (crons, webhooks) runs in an explicit system or tenant scope.
  - Background: [docs/RLS-ROLE-CUTOVER.md](docs/RLS-ROLE-CUTOVER.md) and [MULTITENANCY-SCOPING.md](MULTITENANCY-SCOPING.md).
- **Access control:** database roles and permissions, re-checked on the server for every page, action and file route. See [docs/platform-rbac.md](docs/platform-rbac.md).
- **Sessions:**
  - JWT cookie, 60-minute idle timeout and a 72-hour absolute limit; opting in to the installed app gives a week.
  - Staff can use TOTP 2FA and passkeys.
- **Settings and credentials:** stored per workspace in the database. Secrets (SMTP, Meta, AI keys and so on) are encrypted with `SETTINGS_ENCRYPTION_KEY` and managed under **Settings**, not in env vars.
- **Files:** Vercel Blob. Private documents go to the private store when `BLOB_PRIVATE=true`. Downloads always go through signed-in routes.
- **Money** is stored as integer cents (ZAR).
- **Scheduled jobs** are listed in [vercel.json](vercel.json). They call `/api/cron/*` with `Authorization: Bearer $CRON_SECRET`:

  | Schedule | Jobs |
  | --- | --- |
  | Every 30 min | signing jobs, bot outbox, scheduled emails, journeys, automations, statistics, research, assistant |
  | Daily | backup 02:00 UTC, photo orphans 03:00, competitor watch 05:00 |
  | Hourly | private-storage at :20, Xero payments check at :40 |
  | Monthly | security check on the 1st |

---

## Local development

Requires **Node 22+** and **PostgreSQL 16** (what CI uses).

> **Use a local, disposable Postgres.**
> - Never point a local checkout at production.
> - Don't point it at a hosted database that holds live integration credentials either. Code running against it can send real email, WhatsApp and SMS.

```bash
cp .env.example .env                 # then fill in DATABASE_URL and the secrets marked required
npm ci
npx prisma generate
node --env-file=.env scripts/apply-migrations.mjs   # applies migrations in numeric order (see below)
npx prisma db seed                   # creates the first owner from INITIAL_ADMIN_* (see below)
npm run dev -- -p 4000               # http://localhost:4000
```

- **Why not `prisma migrate dev`?** Migration folders use numeric prefixes that are not zero-padded. Prisma's own runner applies them in text order, which is wrong on a fresh database. `scripts/apply-migrations.mjs` applies them in true numeric order and writes Prisma's ledger, so `prisma migrate status` still agrees. The same runner is used in CI, previews and production.
- **First owner.** The seed creates the owner only from `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` (at least 14 characters), plus `INITIAL_ADMIN_NAME` if set. There is no default password.
  - **In local dev:** with an email but no password, a one-time password is printed.
  - **Production:** the seed refuses to run without both.
  - **Preview deployments:** it never creates a privileged owner.
- **Integrations** (SMTP, IMAP, Meta, AI providers, ElevenLabs and others) are set up in the app under **Settings** once you're signed in.

### Tests and checks

```bash
npm run test:unit    # node:test suite in tests/ (no database needed)
npm run typecheck
npm run lint
```

- The `npm run test:*` integration scripts (signing, tenant isolation, DAX and so on) need a **throwaway** database. Most refuse to run unless its name ends in `_test`.
- CI runs on every PR (see [.github/workflows/](.github/workflows/)):
  - a **fast** job: Prisma schema validation, type check, lint and unit tests;
  - an **integration** job on Postgres 16: migrations from empty, `prisma migrate status`, migration replay-safety, the composite-FK catalogue check, then the seeded integration scripts;
  - visual consistency and a secret scan.
- CI does not run `next build`. Vercel's build is the build check, and it reports as a commit status rather than a check.

---

## Deployment

- **Production deploys from `main`** on Vercel (region `fra1`). The build command is `prisma generate → node scripts/apply-migrations.mjs → next build`.
- **Changes go through a PR to `main`.** A fix found in review targets `main`, not the feature branch (see [AGENTS.md](AGENTS.md)).
- **After a merge, check the change is in `main`** with `git merge-base --is-ancestor <sha> origin/main`.
- **Migrations:**
  - They must be **additive and re-runnable**: `CREATE … IF NOT EXISTS`, and RLS policies dropped before being re-created. Tests enforce this.
  - After a migration ships, confirm the new table, column or index exists on production. A ledger row alone is not proof.
- **Preview deployments must never use the production database.** The build runs migrations, so a preview would migrate prod. See [docs/preview-databases.md](docs/preview-databases.md).
- **Backups:** Neon point-in-time recovery, plus a nightly encrypted portable backup to Blob. See [docs/backup-and-recovery.md](docs/backup-and-recovery.md).
- **New workspace:** [docs/ONBOARDING-A-TENANT.md](docs/ONBOARDING-A-TENANT.md).

---

## Inbound endpoints

| Endpoint | Purpose |
| --- | --- |
| `POST /api/intake` | Website enquiry forms. Header: `X-Api-Key: <workspace intake key from Settings>`. Fields: `name, email, phone, message, model, color, source`; `model` is matched to the catalogue. |
| `/api/webhooks/meta` | Facebook/Instagram Lead Ads and Messenger/Instagram messages. Verify token and Page token are set in Settings. |
| `/api/webhooks/whatsapp` | WhatsApp Cloud API messages and statuses (the inbox, chatbot and DAX). |
| `/api/webhooks/telegram`, `/api/webhooks/x` | Telegram and X channels. |

Every inbound message is mapped to a workspace through its channel identity; nothing is accepted without one.

---

## Docs

[docs/README.md](docs/README.md) indexes every document in the repo and labels each as a **current reference** or a **historical record** (designs, audits and incidents, kept for their reasoning).

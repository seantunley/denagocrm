# Documentation index

Every document in the repo, grouped by whether you can act on it today.

- **Current reference:** reflects how the system works now. Keep these accurate when you change the thing they describe.
- **Historical record:** plans, designs, audits and incident write-ups. They're kept because code comments and tests cite their reasoning. Read them for *why*, not for current state. Many are cited by file name from the code, so they are **not moved or renamed**.

Last checked against the code: 2026-11-06.

## Current reference

| Document | What it covers |
| --- | --- |
| [README.md](../README.md) | What the product does, architecture, local setup, tests and deployment |
| [AGENTS.md](../AGENTS.md) | Rules for anyone (or any agent) changing this repo: Next.js version notes, and fixes target `main`. [CLAUDE.md](../CLAUDE.md) just includes it. |
| [ROADMAP.md](../ROADMAP.md) | What's still open, and what has shipped |
| [.env.example](../.env.example) | Every environment variable the code reads, with what it does |
| [ONBOARDING-A-TENANT.md](ONBOARDING-A-TENANT.md) | Setting up a new workspace: branding, domain, first users |
| [RLS-ROLE-CUTOVER.md](RLS-ROLE-CUTOVER.md) | The `crm_app` database role and how row-level security is made load-bearing (done 2026-09-01) |
| [platform-rbac.md](platform-rbac.md) | Roles, permissions and view scopes (`view_all` / `view_owned`) |
| [backup-and-recovery.md](backup-and-recovery.md) | Neon recovery, the nightly encrypted backup, and restoring |
| [preview-databases.md](preview-databases.md) | Why preview deployments must never use the production database |
| [migration-ledger.md](migration-ledger.md) | Which migration "drift" on production is real and which is expected |
| [enterwith-request-scope-finding.md](enterwith-request-scope-finding.md) | Why tenant scope set with `enterWith` doesn't reach the caller in the production build |
| [visual-consistency-guardrails.md](visual-consistency-guardrails.md) | UI patterns new screens must follow (checked in CI) |
| [kanban-stage-actions.md](kanban-stage-actions.md) | Pipeline stage actions on the kanban board (built in #527) |
| [marketing-platform-rollout.md](marketing-platform-rollout.md) | The governed marketing platform: drafts, review, versions, durable send queues |
| [customer-portal-expansion.md](customer-portal-expansion.md) | The customer portal's self-service scope |
| [save-feedback-rollout.md](save-feedback-rollout.md) | The rule that every save says whether it worked, and where it's applied |
| [dittofeed-borrow-queue.md](dittofeed-borrow-queue.md) | What may be borrowed from Dittofeed (MIT), and in what order |

## Historical record

**Multi-tenancy build (July–September 2026).** All of this is done: enforcement has been live since 2026-08-12 and RLS since 2026-09-01.
- [MULTITENANCY-SCOPING.md](../MULTITENANCY-SCOPING.md), [MULTITENANCY-COMPLETION-PLAN.md](../MULTITENANCY-COMPLETION-PLAN.md), [MULTITENANCY-READINESS-AUDIT.md](../MULTITENANCY-READINESS-AUDIT.md), [MULTITENANCY-REVIEW-PR196-199-200.md](../MULTITENANCY-REVIEW-PR196-199-200.md)
- [PHASE-C-TENANT-GUARD-DESIGN.md](../PHASE-C-TENANT-GUARD-DESIGN.md), [PHASE-C-NO-USER-EDGES-DESIGN.md](../PHASE-C-NO-USER-EDGES-DESIGN.md)
- [DEPLOYMENT-SEQUENCE.md](../DEPLOYMENT-SEQUENCE.md), [TENANT-ENFORCEMENT-PREREQUISITES.md](TENANT-ENFORCEMENT-PREREQUISITES.md), [dormant-mode-is-the-root-cause.md](dormant-mode-is-the-root-cause.md)
- [NEXT-STEPS.md](../NEXT-STEPS.md), [PR-MERGE-PLAN.md](../PR-MERGE-PLAN.md)

**Plans that have been built**
- [BRANDING-ROADMAP.md](../BRANDING-ROADMAP.md): per-workspace branding and custom domains.
- [journeys-own-customer-messages-2026-10-06.md](journeys-own-customer-messages-2026-10-06.md): journeys as the one engine for customer messages.
- [marketing-journeys.md](marketing-journeys.md): the first journeys module. Its note about keeping the old automation rules is out of date; those were retired into Journeys.
- [marketing-pr1-campaign-schema-state-machine.md](marketing-pr1-campaign-schema-state-machine.md), [marketing-platform-scope-matrix.md](marketing-platform-scope-matrix.md), [marketing-platform-test-plan.md](marketing-platform-test-plan.md), [MARKETING-STACK-VS-MAIN-COLLISION.md](../MARKETING-STACK-VS-MAIN-COLLISION.md): the marketing platform PR stack.
- [pipelines-forecasting-rbac-audit.md](pipelines-forecasting-rbac-audit.md): sales governance (pipelines, forecasting, access).

**Audits and incidents**
- [SECURITY-AUDIT-2026-09-01.md](../SECURITY-AUDIT-2026-09-01.md), [SECURITY-RETEST-2026-09-01.md](../SECURITY-RETEST-2026-09-01.md): external-style security review and retest.
- [SILENT-FAILURE-AUDIT.md](../SILENT-FAILURE-AUDIT.md): the "succeeds wrongly" class of bugs.
- [RESEARCH-ACTION-SCOPE-DIAGNOSIS.md](../RESEARCH-ACTION-SCOPE-DIAGNOSIS.md): server actions with no tenant scope (2026-08-13).
- [SIGNING-PDF-LOSS-INCIDENT.md](../SIGNING-PDF-LOSS-INCIDENT.md): signed PDF lost on Q-1010 (2026-08-04).
- [neon-compute-2026-09-23.md](neon-compute-2026-09-23.md): unexpected database compute hours.

**UI reviews**
- [visual-consistency-sweep.md](visual-consistency-sweep.md)
- [ui-3-flowbot-canvas-verification.md](ui-3-flowbot-canvas-verification.md), [ui-3-flowbot-canvas-verification-390.md](ui-3-flowbot-canvas-verification-390.md), [ui/flowbot-inspector-publishing-review.md](ui/flowbot-inspector-publishing-review.md)

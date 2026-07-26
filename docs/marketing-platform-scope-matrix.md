# Marketing platform scope acceptance matrix

| Scope | Delivery | Primary PR | Acceptance evidence |
|---|---|---:|---|
| Governed campaign states | Draft, review, changes, approval, schedule, queue, sending, pause, completion, cancellation and archive | #202 | `campaignLifecycle.ts`, lifecycle tests and migration backfill |
| Persistent campaign drafts | Immediate draft row, autosave, explicit save, reload and duplicate | #207 | `/marketing/campaigns/*`, `CampaignDraftEditor`, draft actions |
| Review and approval | QA, mandatory change notes, separate submitter/approver and immutable snapshots | #208 + final | campaign workflow actions and transactional version locks |
| Safe launch | Exact audience/contact snapshot, schedule or send-now queue creation | #208 + final | `freezeAudienceAndQueue`, campaign versions and recipient rows |
| Delivery-time consent | Opt-out, consent, destination, deletion, tenant, duplicate, quiet-hour and frequency checks | #209 | `communicationPolicy.ts`, campaign queue contracts |
| Atomic campaign delivery | Skip-locked claims, stale recovery, bounded batches, retry/backoff and idempotent counters | #209 + final | `marketingCampaignQueue.ts`, queue indexes and tests |
| Campaign operations | Pause, resume, cancel remaining, selected/manual retry and archive | #209 + final | campaign operation actions and detail controls |
| Campaign workspace | Search, filters, pagination, work queues, detail, versions, events and issue breakdown | #210 | `/marketing/campaigns` list/detail routes |
| Advanced audiences | Nested AND/OR, exclusions, supported fields/operators, live count, explanation and versions | #210 + final | `marketingAudiences.ts`, audience workspace and launch integration |
| Marketing templates | Purpose categories, draft/published/archive and immutable versions | #210 + final | template workspace/actions and locked version publication |
| Survey lifecycle | Inactive draft, review, approval, publish, deactivate/archive and revision | #211 | survey workflow/state machine and governance pages |
| Frozen survey versions | Immutable published snapshots and old-link compatibility | #211 + final | `SurveyVersion`, frozen public loader/submission runtime |
| Trigger ownership | One active survey per trigger and explicit transactional replacement | #211 | migration constraint and publish workflow |
| Survey distributions | Frozen survey version, exact audience, schedule, durable recipients | #212 | `SurveyDistribution`, creation actions and pages |
| Atomic survey delivery | Skip-locked claims, stale recovery, purpose-aware consent and bounded batches | #212 + final | `surveyDistributionQueue.ts` and cron wiring |
| Survey reminders | Delay, maximum count, reminder leases, stale recovery and finalisation rules | #212 + final | reminder worker and distribution settings |
| Survey operations | Pause, resume, cancel remaining, retry and separate suppression/failure reporting | #212 | distribution detail/actions |
| Survey analytics | Correct response-rate denominator, NPS, CSAT and response latency | #213 | `surveyAnalytics.ts`, unit tests and insights route |
| Closed-loop feedback | Automatic low-score follow-ups, owner, due time, resolve/reopen and support-case escalation | #213 | `SurveyFollowUp`, actions and recovery queue |
| Campaign tracking | Open/click touches and governed UTM parameters | #215 | tracking routes and `MarketingTouch` ledger |
| Attribution | Bounded last-click lead, quote, accepted quote and won-sale conversions | #215 + final | `CampaignConversion`, DB triggers and reconciliation function |
| Marketing economics | Attributed revenue, ROAS and cost per lead without invented denominators | #215 | overview service and tests |
| Unified overview | Campaign performance, survey health, top campaigns and human work queues | #215 | `/marketing/overview` |
| Unified calendar | Scheduled campaigns and survey distributions | #215 | `/marketing/calendar` |
| Module and navigation governance | Marketing pack route ownership, module gate and governed navigation | final | module registry, layout, navigation and module tests |
| Legacy compatibility | Historical data preserved; legacy reads retained; direct bulk sends retired | #202 + final | migrations, compatibility actions and integration contracts |
| Help and operations | Governed Help Centre, rollout/rollback and full test plan | final | help dataset and three marketing platform documents |
| Cross-module validation | Source contracts for bypass retirement, queues, frozen versions, audiences and route gates | final | `marketingGovernanceIntegration.test.ts` and migration contracts |

## Definition of complete

The implementation scope is complete when all ten PRs are present, the final stacked branch contains every row above, migrations apply cleanly to empty and historical databases, and the required commands in `marketing-platform-test-plan.md` pass on working repository infrastructure.

A red CI job with zero executed steps is an infrastructure failure, not an acceptance result. No PR should merge until the complete stack is validated on a functioning runner or equivalent local environment.

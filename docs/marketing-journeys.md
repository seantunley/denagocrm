# Marketing journeys and advanced automations

This module adds versioned, multi-step journeys without removing the existing single-action automation rules.

## Architecture

- `Journey` owns the workflow identity and lifecycle state.
- `JourneyVersion` stores immutable published definitions. Existing runs remain pinned to the version that enrolled them.
- `JourneyEvent` is the durable event inbox. Unique dedupe keys prevent duplicate enrollment for the same business event.
- `JourneyRun` stores resumable execution state, the next due time, retry state and the lead/contact context.
- `JourneyStepLog` records each step result for operator visibility and recovery.
- `/api/cron/journeys` processes journey work every five minutes independently of the general CRM automation cron.

The engine supports:

- event triggers for lead creation, stage changes, won/lost leads, quotes, delivery and referrals;
- scheduled enrollment for idle leads, saved contact segments, purchase anniversaries and win-back;
- email, SMS, team push notifications, activities, assignment, stage changes and contact tags;
- delays measured in minutes, hours or days;
- allow-listed entry conditions and conditional branches;
- draft/publish versioning, pause/resume, archive, cancel and retry controls.

## Safety and delivery semantics

Journey definitions never execute arbitrary JavaScript or database queries. Conditions and actions are parsed against explicit allow-lists.

Marketing email and SMS actions re-check `Contact.marketingOptOut` immediately before sending. This protects contacts who opt out after enrollment but before a delayed step runs.

Runs are idempotent at enrollment and each step has one durable step-log record. External email and SMS providers do not expose a transactional send-and-record operation, so message delivery is **at least once** in the narrow failure window where a provider accepts a message but the application process stops before the step is marked complete. Operators should review the communication history before manually retrying a failed send step.

Stale `processing` events and `running` runs are automatically recovered after 15 minutes. Only queued or waiting runs can be cancelled safely. Failed and cancelled runs can be retried.

## Deployment

The application now uses Prisma's multi-file schema support:

```bash
npm run prisma:generate
npm run prisma:migrate
npm run typecheck
npm run test:journeys
npm run build
```

Vercel deploys migrations during the configured build command. Confirm that the deployment environment has:

- `DATABASE_URL`
- `DATABASE_URL_UNPOOLED`
- `CRON_SECRET`
- the existing SMTP and/or BulkSMS settings required by enabled journey actions

After deployment:

1. Open **Automations → Advanced journeys**.
2. Install the recommended drafts.
3. Review and publish only the workflows required for the initial rollout.
4. Confirm `/api/cron/journeys` returns HTTP 200 when invoked by Vercel Cron.
5. Create a test lead and confirm an event, run and step history appear.
6. Test a delayed journey with a short wait before using day-based production delays.
7. Confirm marketing opt-out suppresses email and SMS at execution time.

## Legacy lifecycle migration

The old anniversary and win-back jobs remain supported during rollout. Before activating equivalent advanced journeys, disable these settings to avoid duplicate messages:

- `LIFECYCLE_ANNIVERSARY_ENABLED`
- `LIFECYCLE_WINBACK_ENABLED`

The journeys page displays a warning while either legacy setting remains enabled.

## Recommended initial rollout

1. Publish **New lead speed-to-contact** first because it only creates internal actions.
2. Test **Won-customer welcome** with an internal/test contact.
3. Disable the matching legacy lifecycle toggle before publishing **Purchase anniversary** or **Service win-back**.
4. Start segment journeys with a small, purpose-built saved segment.
5. Monitor failed runs and provider delivery logs during the first week.

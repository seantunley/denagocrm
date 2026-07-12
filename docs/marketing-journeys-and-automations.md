# Marketing journeys and automation engine

## Purpose

This module upgrades Denago CRM from one-trigger/one-action rules to durable,
versioned, multi-step journeys while preserving the existing `AutomationRule`
engine during migration.

## Architecture

- `MarketingJourney` stores the journey identity, trigger and live controls.
- `MarketingJourneyVersion` stores immutable published definitions and editable
  draft definitions.
- `MarketingJourneyEnrollment` stores each lead/contact's progress, wake time,
  consent/reply stop state and pinned version.
- `MarketingJourneyStepRun` stores step-level execution history and errors.
- `src/lib/marketingJourneys.ts` validates and executes definitions without
  `eval` or arbitrary code execution.
- `/api/cron/automations` drains due enrolments on the existing Vercel Cron.

Existing legacy rules continue to run from `src/lib/automations.ts`. Published
journeys are enrolled from the same CRM event dispatcher.

## Supported triggers

- `lead_created`
- `stage_entered`
- `lead_won`
- `lead_lost`
- `quote_signed`
- `quote_declined`
- `delivered`
- `referral_earned`
- `lead_idle`
- `purchase_anniversary`
- `winback`

## Supported steps

- `wait`
- `condition`
- `send_campaign`
- `send_email`
- `create_activity`
- `move_stage`
- `assign_user`
- `add_tag`
- `remove_tag`
- `send_push`
- `end`

Marketing messages should use `send_campaign`. This preserves the existing
campaign recipient records, open tracking, click tracking and unsubscribe
links. `send_email` is intended for transactional or direct sales/service
messages.

## Conditions

Conditions are structured JSON. Supported operators are:

- `eq`
- `neq`
- `contains`
- `gt`
- `gte`
- `lt`
- `lte`
- `empty`
- `not_empty`
- `in`

Fields are read from the safe journey subject object:

- `lead.*`
- `contact.*`
- `event.*`

Examples:

- `lead.source`
- `lead.valueCents`
- `lead.status`
- `lead.stageId`
- `contact.province`
- `contact.marketingOptOut`
- `event.vehicleModel`

## Example

```json
{
  "entryConditions": {
    "mode": "and",
    "conditions": [
      { "field": "lead.valueCents", "operator": "gte", "value": 10000000 }
    ]
  },
  "steps": [
    {
      "type": "create_activity",
      "activityType": "call",
      "summary": "Call {{name}}",
      "dueHours": 2
    },
    { "type": "wait", "hours": 24 },
    {
      "type": "condition",
      "conditions": {
        "mode": "and",
        "conditions": [
          { "field": "lead.status", "operator": "eq", "value": "open" }
        ]
      },
      "onTrue": 3,
      "onFalse": 5
    },
    { "type": "send_campaign", "campaignId": "CAMPAIGN_ID" },
    { "type": "wait", "hours": 72 },
    { "type": "end", "reason": "journey completed" }
  ]
}
```

Step indexes are zero-based. Branch destinations must point to an existing step
or one position after the final step to complete naturally.

## Consent and safety

When `respectMarketingConsent` is enabled:

- Contacts with `marketingOptOut = true` are not enrolled.
- The latest marketing consent ledger entry is enforced when one exists.
- Missing contacts cannot enter a consent-controlled marketing journey.

When `stopOnReply` is enabled, an inbound communication after the journey's
last outbound message stops the enrolment.

Frequency caps use recent outbound email/WhatsApp communication history to
prevent excessive contact.

## Publishing model

1. New journeys start as drafts and are inactive.
2. Saving a published journey creates a new draft version.
3. Publishing archives the previous published version and activates the new
   immutable version.
4. Existing enrolments remain pinned to the version with which they started.
5. Pausing prevents new processing until resumed.
6. Archiving stops active/waiting enrolments and preserves history.

## Existing lifecycle settings

The hard-coded anniversary and win-back routines remain enabled for migration
safety. Disable these settings after equivalent published journeys have been
validated:

- `LIFECYCLE_ANNIVERSARY_ENABLED`
- `LIFECYCLE_WINBACK_ENABLED`

Running both the old routine and a published equivalent journey may create
duplicate messages.

## Deployment

1. Apply migration `44_marketing_journeys_v3` to the Neon database through the
   normal Vercel/Prisma deployment path.
2. Confirm the Vercel preview build and type checking pass.
3. Open **Automation → Marketing journeys**.
4. Create a draft journey with a non-sending first step, such as a task.
5. Publish it.
6. Trigger the matching event on a test lead/contact.
7. Run the automation cron with authorised credentials.
8. Confirm enrolment and step-run history.
9. Test wait/wake behaviour on the next cron cycle.
10. Test consent exclusion and stop-on-reply before enabling sending journeys.

## Rollback

- Pause or archive all journeys from the UI.
- Legacy `AutomationRule` rules continue to operate independently.
- Do not drop the journey tables while enrolment history is required.
- Database migration rollback should be performed only on an isolated Neon
  recovery branch after exporting journey definitions and run history.

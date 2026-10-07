# Journeys own every automatic customer message — design (2026-10-06)

Approved plan (Sean): one engine for customer messages, which is journeys. Add the
missing triggers, turn each built-in sender into a ready-made journey (off by
default, visible and editable in the builder), and the Automatic page lists only
housekeeping plus a link to Journeys.

## What moves where

| Built-in sender (before) | Ready-made journey (after) | Trigger(s) | Step |
|---|---|---|---|
| `sendReviewRequest` called from job-card completion and vehicle "new delivery" (switch `REVIEW_REQUESTS_AUTO`) | **Google review request** | `job_completed`, `vehicle_delivered` (new, event) | `send_review_request` |
| `runServiceReminders` cron phase (switch `SERVICE_REMINDER_ENABLED` + a picked template) | **Service-due reminder** | `service_due` (new, scheduled) | `send_service_reminder` |
| `runSignatureRequestReminders` cron phase + the sequential "re-nudge" in `notifyNextInSequence` (switch `SIGNING_AUTO_REMINDERS`) | **Signing reminder** | `signing_unsigned` (new, scheduled, `days` default 3) | `send_signing_reminder` |
| Survey queue reminders for automatically-sent surveys (switch `SURVEY_AUTO_REMINDERS`) | **Survey reminder** | `survey_unanswered` (new, scheduled, `hours` default 48) | `send_survey_reminder` |

The module steps call each module's own sending function, so the per-recipient
signing link, the survey link, the Google review link, templates, timeline
logging (secrets masked), opt-outs / consent checks, idempotency and caps all stay
in the module that already had them:

- review: `canContactPerson(purpose "review")`, one ask per customer per 90 days, Place ID required.
- service: `canContactPerson(purpose "service")`, one reminder per vehicle per due-cycle (`ServiceReminderLog`), refusal recorded once per cycle. Uses the picked reminder template, else the editable "Service reminder" template. Email only, as before.
- signing: claim `remindedAt` (one reminder per signer, ever), only signers still `sent`/`viewed` on a live request, `notifyRecipient(…, { reminder: true })` (editable `reminder` / `reminder_whatsapp` templates, link masked on the timeline), claim released if nothing was accepted.
- survey: claim on `lastReminderAt` (one reminder per response), `canContactPerson` with the distribution's purpose, editable `survey_reminder` templates, link masked; quiet hours / frequency cap hold the step and retry instead of dropping it.

A module step whose trigger didn't give it what it needs (e.g. "Send signing
reminder" in a lead journey) skips and says why in the run trace.

## Enrolment

- Event triggers (`job_completed`, `vehicle_delivered`) are emitted by
  `emitContactJourneyEvent` — the contact twin of `emitLeadJourneyEvent`: gated on
  the Marketing pack, never throws, deduped per occurrence (job card + completion
  time; vehicle id).
- Scheduled triggers are swept per tenant by `runScheduledJourneyEnrollments`,
  tenant named in every query, each candidate emitted once per journey version
  (dedupe key: record id, plus the due-cycle for service):
  - `service_due`: vehicles due soon / overdue, customer has an email, no reminder logged for this cycle; Automotive pack only (as before).
  - `signing_unsigned`: signers not yet reminded whose latest delivery is ≥ N days old on a live request (≤ 25 per tick, as before). Enrols the request's customer: its contact, else its quote's or job card's contact, else the quote's lead.
  - `survey_unanswered`: responses to automatically-sent surveys, unanswered, never reminded, sent ≥ N hours ago and within 3 days of that — so switching it on doesn't remind months-old surveys.
- Ready-made journeys use run mode `parallel`: two vehicles or two signers on one
  customer are separate messages, and the module's own claim is what stops a double.

## Seeding and defaults

`ensureReadyMadeJourneys(tenantId)` (`src/lib/readyMadeJourneys.ts`) runs when the
journeys cron reaches a tenant and when the Journeys or Automatic page loads. In
one transaction under a per-tenant advisory lock it creates each missing
ready-made journey (published v1, run mode parallel) and an AppSetting marker
`READY_MADE_JOURNEY:<key>` = journey id. The marker is the unique key: a
ready-made journey is created once per workspace, ever — deleting or archiving it
is respected, never re-created. Each creation is audited.

Starts **paused (off)** unless the old switch is explicitly stored as `"true"`
(for service: and a reminder template was picked, because without one the old job
sent nothing). No schema change.

## Old paths can't send

- `runServiceReminders` and `runSignatureRequestReminders` are deleted, and their cron phases removed.
- The sequential re-nudge in `notifyNextInSequence` is removed (the signer is reminded by the journey once their delivery is N days old).
- `sendDueReminders` never claims a reminder for an automatically-sent survey; automatic distributions are created with `maxReminders: 0`.
- Job-card completion and vehicle registration emit journey events instead of calling `sendReviewRequest`.
- The four switches are no longer read anywhere except by the seeding (as evidence of a prior approval); the Settings → Signing security toggle and the Service-reminders "enabled" tick box are replaced by the journey's state and a link.
- `tests/automationRegister.test.ts` fails the build if any module sender is called from anywhere but the journey step executor, if a customer-facing register entry isn't a journey or a documented exception, or if a ready-made journey defaults on.

## What stays on the Automatic page

Housekeeping and staff jobs as before; the transactional/person-driven customer
sends that are not journeys, each saying where it is switched on: signed copies
(`SIGNING_SIGNED_COPIES`, on by Sean's choice), next signer in line, survey
invitations (switched on per survey), campaigns (approved per campaign), chatbot,
help-desk auto-reply. A new section "Customer messages are journeys" lists each
ready-made journey with on/off and a link to /journeys.

## Risks / known changes

- **Marketing pack off** → journeys don't run, so these messages don't either (the cron and the emitters are gated on Marketing). Review requests and signing reminders used to run without it. Safe direction (no message); the Automatic page says so when Marketing is off.
- Signing reminders reach only requests with a customer record (contact, quote or job card). A document sent to someone with none attached gets no automatic reminder; Resend by hand still works.
- The immediate re-nudge of an already-sent next signer becomes the normal reminder after N days.
- Service reminders now fall back to the editable "Service reminder" template when no template is picked (the journey starts on only where one was picked).

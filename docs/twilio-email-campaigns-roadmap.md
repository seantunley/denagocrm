# Twilio email campaigns roadmap

## Product decision

Use **Twilio SendGrid** as the email delivery provider while Denago CRM remains
the system of record for contacts, consent, campaign membership, content, and
sales outcomes. This gives the CRM provider-grade delivery signals without
splitting customer history across two campaign databases.

Twilio Messaging and Voice are related future integrations, but they use
different products, credentials, webhooks, consent rules, and data lifecycles.
They should share the same integration framework rather than share one
all-powerful credential.

## Foundation delivered by this PR

- Per-tenant SendGrid API key, verified sender, unsubscribe mailbox, and signed
  Event Webhook public-key settings.
- SendGrid Web API transport with SMTP fallback.
- Opaque CRM campaign and recipient IDs in SendGrid custom arguments; no contact
  names, email addresses, or tenant IDs are put in custom arguments.
- Atomic recipient claims with stale-claim recovery, preventing overlapping cron
  workers from sending the same recipient twice.
- Consent rechecked immediately before every send, plus duplicate address
  suppression when an audience snapshot is created.
- RFC 8058 one-click unsubscribe headers. Browser GET requests only display a
  confirmation page; only POST changes consent, so link scanners cannot
  unsubscribe a contact.
- Signed, timestamp-bounded SendGrid Event Webhook processing with idempotent
  event storage.
- Separate accepted, delivered, deferred, bounced, dropped, complaint,
  unsubscribe, open, and click measures. Delivery/open/click rates use confirmed
  delivery when it is available.
- Click-event URLs and a top-links report on the campaign detail page.
- Append-only consent records for unsubscribe and spam-complaint events.

## Target architecture

```text
Campaign audience
  -> consent + address dedupe
  -> atomic queue claim
  -> SendGrid Mail Send API
  -> signed Event Webhook
  -> immutable CampaignEvent ledger
  -> recipient delivery state + campaign totals
  -> CRM activity, opportunity and revenue attribution
```

## Phase 1 — production enablement

1. Create a SendGrid subuser or account boundary for each tenant. Do not share an
   unrestricted parent-account key.
2. Grant the API key only Mail Send permission.
3. Authenticate each sending domain and verify SPF, DKIM, and DMARC alignment.
4. Configure branded link tracking and a verified From identity.
5. Enable the signed Event Webhook at
   `https://<crm-host>/api/webhooks/sendgrid`, copy its verification key into the
   tenant’s Email settings, and subscribe to:
   `processed`, `delivered`, `deferred`, `bounce`, `dropped`, `spamreport`,
   `unsubscribe`, and `group_unsubscribe`.
6. Run seed-list tests through Gmail, Microsoft, Yahoo, and a corporate mailbox.
   Confirm that each recipient moves from accepted to delivered or a terminal
   failure.
7. Add operational alerts for webhook signature failures, a delivery rate below
   95%, bounce rate above 2%, complaint rate above 0.1%, and a growing stale queue.

Exit criteria: every production tenant has domain authentication, least-privilege
credentials, verified webhook events, and an identified owner for deliverability.

## Phase 2 — campaign operations

- Draft, schedule, pause, resume, and cancel campaigns. Scheduling must store the
  tenant timezone and an immutable audience snapshot.
- Preflight checks for missing unsubscribe links, broken URLs, missing image alt
  text, message size, empty personalisation values, and risky/spam-like content.
- Send test emails to a named seed list and retain the exact rendered artifact.
- Estimate audience changes before launch: included, duplicate, opted out,
  invalid, and provider-suppressed.
- Add retry policy controls for transient API failures. Bounces, drops, complaints,
  and withdrawn consent must never be retried as ordinary transient failures.
- Add a webhook-health panel showing last valid event, last invalid signature,
  event lag, and unmapped event count.

Exit criteria: an operator can safely prepare, approve, schedule, stop, and audit
a campaign without database or cron intervention.

## Phase 3 — deliverability and suppression

- Sync SendGrid global and group suppressions into a dedicated CRM suppression
  ledger. Keep suppression separate from legal consent: a hard bounce is not the
  same fact as a person withdrawing consent.
- Classify hard bounce, soft bounce, block, invalid address, and policy drop.
- Add email validation at contact entry/import and an address-change revalidation
  workflow.
- Add sender reputation trends by tenant/domain and a dedicated-IP decision
  framework. Use a shared IP until volume is sufficiently consistent; if moving
  to a dedicated IP, use an explicit warm-up plan.
- Configure DMARC reporting and move gradually from monitoring to quarantine or
  reject once legitimate sources align.

Exit criteria: operators can explain why an address was excluded and can restore
it through an audited process when the underlying issue is resolved.

## Phase 4 — analytics that connect to sales

- Time-series charts for requested, accepted, delivered, bounced, opened, clicked,
  unsubscribed, and complained.
- Unique and total click reports by URL; optional device/client data only when
  there is a clear business need.
- Attribute CRM outcomes after a campaign: reply, lead created, test drive booked,
  quote created, sale won, and revenue. Use explicit attribution windows and show
  first-touch and last-touch separately.
- Campaign comparison by audience, source, template, sender, and product.
- Export event-level evidence with tenant, retention, and permission controls.
- Treat opens as directional because privacy proxies and image blocking distort
  them. Prefer clicks, replies, bookings, pipeline movement, and revenue.

Exit criteria: a campaign report answers both “was it delivered?” and “what
commercial outcome followed?”

## Phase 5 — experimentation and optimisation

- A/B test subject, From name, content, CTA, and send time.
- Allocate variants deterministically, protect a holdout group, set a minimum
  sample size, and choose one primary success metric before launch.
- Do not auto-pick a winner on open rate alone. Default to unique click rate or a
  CRM conversion; require sufficient observation time.
- Add send-time optimisation only after there is enough per-recipient engagement
  history and a conservative fallback window.
- Add reusable automation journeys for welcome, lead nurture, test-drive
  follow-up, abandoned quote, service reminder, and win-back.

Exit criteria: experiments are reproducible, statistically guarded, and measured
against a customer or commercial outcome.

## Phase 6 — wider Twilio integration

- Replace BulkSMS only after a separate SMS migration proves sender availability,
  opt-out keywords, delivery receipts, template behaviour, pricing, and number
  portability in each operating country.
- Add Twilio Voice as its own bounded adapter: browser/SIP calling, status
  callbacks, recording callbacks, retention controls, and CRM timeline matching.
- Use a shared event envelope and integration-health UI across Email, Messaging,
  and Voice, but separate credentials and permissions by product and tenant.
- For SIP phones, store call metadata first. Import recordings only after recording
  consent, access, retention, deletion, encryption, and regional storage policies
  are approved.

## Security, POPIA, and operations

- Confirm Twilio’s current processing regions, sub-processors, DPA, and transfer
  mechanism before production use. Event Webhook payload handling and SendGrid
  storage location must be part of the POPIA assessment.
- Minimise event metadata, encrypt credentials, never log API keys or full webhook
  payloads, and retain raw provider events only for an approved period.
- Keep campaign events tenant-scoped and test cross-tenant recipient IDs,
  signatures, settings, analytics, exports, and cron workers.
- Rotate keys without downtime, document webhook-key rotation, and revoke old
  credentials immediately after verification.
- Backfill and deploy the additive database migration before enabling SendGrid.
  SMTP remains the rollback transport; disabling the SendGrid API key reverts new
  sends without deleting the event ledger.

## Official implementation references

- [Twilio SendGrid Marketing Campaigns](https://www.twilio.com/en-us/products/marketing-campaigns)
- [SendGrid Event Webhook overview](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/event)
- [Signed Event Webhook security](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features)
- [List-Unsubscribe and one-click unsubscribe](https://www.twilio.com/docs/sendgrid/ui/sending-email/list-unsubscribe)
- [SendGrid deliverability guide](https://www.twilio.com/docs/sendgrid/ui/sending-email/deliverability)

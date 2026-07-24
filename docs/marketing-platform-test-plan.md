# Governed marketing platform test plan

## 1. Tenant and permission isolation

- Create two tenants with contacts, campaigns, audiences, templates, surveys and distributions using overlapping names.
- Confirm every `/marketing/*` list and detail route returns only the active tenant's records.
- Attempt cross-tenant campaign, audience, template, survey, distribution and follow-up IDs in server actions; each must fail without mutation.
- Verify granular create, edit, review, approve, schedule, send, pause, retry, cancel and archive permissions independently.
- Disable the marketing module and confirm navigation, pages and server mutations are unavailable while core CRM remains available.

## 2. Campaign drafts and governance

- Create a campaign and confirm a draft row exists before content is complete.
- Edit, wait for autosave, reload and compare every field including audience, UTM and attribution settings.
- Confirm before-unload warning with unsaved changes.
- Submit invalid content and verify server QA blocks review.
- Submit valid content and confirm an immutable `in_review` snapshot.
- Confirm the submitting user cannot approve the campaign.
- Request changes with and without a note; only the noted request succeeds.
- Approve with a different user and confirm the state change and immutable approved snapshot are one transaction.
- Run simultaneous submit/approve/version requests and confirm ordered, unique versions.

## 3. Audience and template governance

- Build nested AND/OR audiences with exclusions and compare the result against hand-selected contacts.
- Test every allowed field/operator and invalid field/operator rejection.
- Confirm maximum depth and rule-count limits.
- Save the same audience concurrently and confirm unique ordered versions.
- Archive an audience and confirm it can no longer be selected or edited.
- Select a saved audience in a campaign, approve it, change the audience, then launch. Confirm launch freezes the latest selected version and exact contact IDs.
- Save, publish and archive each template category.
- Confirm published templates cannot be edited in place and each publish has an immutable version.
- Attempt a same-ID cross-tenant template update and confirm it fails.

## 4. Campaign scheduling and queue concurrency

- Queue an approved campaign immediately and schedule another in the future.
- Confirm no provider call occurs in the web request.
- Run two campaign workers concurrently; each recipient must be claimed and sent once.
- Kill a worker after claim and confirm stale-claim recovery.
- Pause while sending and confirm no new provider calls; resume and complete.
- Cancel while sending and confirm sent recipients remain sent while pending work becomes cancelled.
- Force temporary and permanent provider failures and verify backoff, retry limit and counters.
- Retry selected permanent failures and verify `failedCount` reconciliation.
- Create an all-suppressed campaign and confirm `completed_with_errors`, not a stuck queued state.

## 5. Delivery-time communication policy

For both campaigns and marketing-purpose surveys:

- Queue a contact, then opt out before worker execution; expect suppression.
- Withdraw consent after queue creation; expect suppression.
- Delete the contact or remove the destination; expect the recorded suppression reason.
- Exceed frequency cap; expect a temporary policy block rather than duplicate delivery.
- Test quiet hours in `Africa/Johannesburg`.
- Confirm transactional surveys are not incorrectly blocked by marketing opt-out rules.
- Confirm duplicate delivery checks exclude the recipient currently being processed.

## 6. Tracking and attribution

- Click a tracked URL with no existing UTMs and verify defaults are appended.
- Click a URL with explicit UTMs and confirm those values are preserved.
- Repeat opens/clicks and verify idempotent touch keys where intended.
- Create a lead after a click inside the attribution window; expect `lead_created` conversion.
- Send and accept a quote; expect quote conversions with selected-item and fee value.
- Mark the lead won; expect one `sale_won` conversion and attributed revenue.
- Repeat status updates and confirm no duplicate conversion.
- Create the same events outside the attribution window and confirm they remain unattributed.
- Reconcile campaign counters with `CampaignConversion` using the database reconciliation function.

## 7. Survey lifecycle and frozen versions

- Create a survey and confirm it is inactive draft.
- Validate empty, duplicate, unsupported and invalid-scale questions.
- Submit and approve with separate users.
- Publish and confirm an immutable version and one active trigger owner.
- Attempt simultaneous publication and confirm ordered versions and no duplicate trigger owner.
- Open an invitation for version 1, publish version 2, then submit the old invitation. The version 1 questions and thank-you message must still render and validate.
- Attempt malformed public answers, unsupported choice values, out-of-range scores and duplicate submission.

## 8. Survey distributions and reminders

- Create immediate and scheduled distributions from a published survey.
- Verify exact audience snapshot and one recipient per contact.
- Run two workers concurrently and confirm one invite per response.
- Pause, resume and cancel remaining work.
- Force temporary/permanent failures and exercise manual retry.
- Test reminder delay, maximum count and stale reminder-lease recovery.
- Confirm permanent policy blocks consume future reminder eligibility while quiet-hour/frequency blocks can retry later.
- Confirm a distribution does not finalise before reminder obligations are exhausted.

## 9. Survey analytics and closed-loop recovery

- Use a fixture with sent, completed, failed and suppressed rows and verify the response-rate denominator.
- Verify NPS promoter/passive/detractor classification and formula.
- Verify CSAT uses only completed scored CSAT/post-sale responses.
- Verify average response latency begins at actual delivery.
- Submit low NPS and CSAT responses and confirm one follow-up per response with expected severity/due time.
- Assign to an active tenant member; reject disabled/cross-tenant users.
- Resolve and reopen with audit records.
- Escalate to a support case and confirm customer, score and comment context.

## 10. UI, accessibility and regression

- Test campaign editor, lists, review, detail, audiences, templates, survey governance, distributions, insights, overview and calendar on mobile and desktop.
- Verify keyboard navigation, labels, focus states, status text and error announcements.
- Confirm legacy `/campaigns` and `/surveys` remain readable but cannot launch bulk sends.
- Confirm help search returns governed guidance rather than retired direct-send instructions.
- Run the full existing CRM test suite to detect unrelated quote, contact, lead, workshop, portal and signing regressions.

## Required automated commands

Run on the complete stacked branch:

```bash
npm run prisma:validate
npm run prisma:generate
npm run typecheck
npm run lint
npm run test:unit
npm run check:visual
npm run build
```

Also replay migrations against:

1. an empty database;
2. a production-like database containing historical campaigns, recipients, segments, templates, surveys and responses;
3. the same database a second time where repository migrations are designed to be replay-safe.

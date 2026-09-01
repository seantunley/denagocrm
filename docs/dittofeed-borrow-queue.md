# What to take from Dittofeed — queued

[dittofeed/dittofeed](https://github.com/dittofeed/dittofeed) is an open-source
omni-channel engagement platform: segments, a journey builder, broadcasts, and
email/SMS/push/WhatsApp/Slack delivery.

**Licence.** The repository's top-level `LICENSE` is plain MIT (`Copyright (c)
[2023] [Idea Market inc.]`), with no commercial or hosted-use restriction. One
caveat before any code is lifted: `packages/backend-lib/package.json` declares
`"license": "LicenseRef-LICENSE"` rather than `"MIT"`. That is most likely sloppy
metadata rather than a different grant, but it should be confirmed per package,
and MIT requires the copyright notice to travel with anything copied.

---

## What we are NOT taking, and why

**The engine.** `packages/backend-lib` depends on **Temporal**
(`@temporalio/worker`, `client`, `workflow`), **ClickHouse**, and **Kafka**. That
is a stateful cluster: long-running workers, a columnar event store, a broker.

We run on Vercel serverless + Neon + cron. Adopting their journey engine means
adopting that infrastructure, and it would replace machinery we have already
built and hardened — journey runs, the durable outbox with leases and claim
generations, the inbound event ledger. Temporal is genuinely what you reach for
when you stop hand-rolling durable execution, and that is a real argument for
*later*; it is not portable to this deployment today.

**The features that duplicate ours.** Journeys, segments, broadcasts, the
node-graph builder, multi-channel send, dashboard analytics. We have all of it.

---

## Queued

### 1. `packages/emailo` — low-code email editor

The gap this fills is real: our document editor is PDF-shaped (rows → cols →
blocks with an overlay field editor), and email is a different medium with
different constraints. We have no email template editor at all.

`emailo` is a standalone package, which is what makes it worth porting rather
than reimplementing.

- **Scope**: evaluate the package boundary, its output format, and whether it can
  be consumed without `backend-lib`.
- **Risk**: medium — it is a real editor, so it carries its own dependency tree.
- **Blocked on**: nothing.

### 2. MJML for responsive email HTML

Responsive email HTML is a genuinely nasty problem — table layouts, client
quirks, inlined CSS — and MJML is the mature answer. Dittofeed templates in
HTML/MJML.

Small, isolated dependency. No architectural commitment, and useful on its own
even if `emailo` is not taken.

- **Scope**: MJML → HTML at send time for campaign and journey email steps.
- **Risk**: low.
- **Sequencing**: do this one first; it is independently useful and it is the
  format `emailo` would emit into.

### 3. Subscription groups / unsubscribe management

Directly POPIA-relevant, and a well-trodden design worth reading before
inventing. Their model separates a *subscription group* from the channel, so one
person can be unsubscribed from marketing while still receiving service
messages — which is exactly the distinction a CRM that also sends booking
confirmations needs.

- **Scope**: read their model, compare against what we do today, then decide.
  Read-then-decide, not a port.
- **Risk**: low to read; the change it implies could be larger.
- **Note**: interacts with the marketing journey work — see
  [marketing-journeys.md](./marketing-journeys.md).

### 4. Their segment operator model — comparison material only

A declarative, serialisable segment definition with a fixed operator set. We
already have segments, so this is a design read rather than a port: worth knowing
where their operator set is richer than ours and whether any of the difference
matters for our audiences.

- **Scope**: read `packages/isomorphic-lib` segment types, write up the delta.
- **Risk**: none — no code changes implied by the task itself.

---

## Order

1. **MJML** — smallest, independently useful, and the substrate for (1).
2. **Subscription groups** — read and decide; compliance-adjacent.
3. **`emailo`** — the largest, and better attempted once MJML is in.
4. **Segment operators** — a write-up whenever there is a gap.

This document exists so the evaluation is not re-litigated from scratch, and so
the licence position is recorded next to the decision rather than rediscovered
later.

---

## Status (updated 2026-09-01)

1. **MJML — SUPERSEDED, deliberately.** The problem MJML was queued for was
   solved another way during the campaign email work: `emailShell` in
   `campaigns.ts` is the responsive, brand-aware frame, and
   `src/lib/emailInlineStyles.ts` inlines styles on every body at send time —
   covering ALL templates, not only ones authored in a new format. The full
   argument is at the top of `emailInlineStyles.ts`. Do not add MJML without
   reading it; the frame it would replace is verified and tracking-aware.

2. **Subscription groups — COMPARED AND DECIDED**, see
   [Item 2 completed](#item-2-completed-subscription-groups--read-compared-decided-2026-09-01).
   No group entities; consolidate the three preference stores, then per-channel
   opt-out, then a minimal preference page.

3. **`emailo` — DELIVERED NATIVELY, not ported.** Their editor's value is
   email-safe building blocks, and porting the package would have brought its
   dependency tree along. Instead: `src/lib/emailBlockHtml.ts` (bulletproof CTA
   button, divider, spacer — pure generators, inline-styles-only, tracking- and
   inliner-compatible) + `src/components/emailBlockNodes.ts` (Tiptap atoms that
   render THROUGH the generators and parse their own output back, so saved
   templates reopen editable). Both email surfaces have the tools, and the
   template preview now renders through the real send pipeline
   (`emailPreviewHtml`) instead of iframing raw editor HTML. Guarded by
   `tests/emailComposerBlocks.test.ts`.

4. **Segment operators — DELTA WRITTEN UP AND DECIDED**, see
   [Item 4 completed](#item-4-completed-segment-operator-delta--written-up-2026-09-01).
   Three operators worth taking: `within_days`, `opened_campaign`/`clicked_campaign`,
   `random_bucket`.

---

## Item 2 completed: subscription groups — read, compared, decided (2026-09-01)

Read from `packages/backend-lib/src/subscriptionGroups.ts` and
`subscriptionManagementPage.ts` at `dittofeed/dittofeed@main`.

### Their model

A `SubscriptionGroup` is an admin-defined entity per **channel** (email, SMS,
…), typed `OptIn` or `OptOut`, with a per-user assignment. On top of that:

- an HMAC-signed preference-page URL per recipient (`generateSubscriptionHash`
  over workspace + user + identifier, keyed by a per-workspace secret) — no
  session needed, not guessable, and the same mechanism signs one-click
  subscribe/unsubscribe links;
- a **preference centre** grouping a user's subscriptions by channel, with
  per-group checkboxes and an unsubscribe-all;
- every change recorded as an event, and groups usable **inside segments**
  (`SubscriptionGroup` / `SubscriptionGroupUnsubscribed` nodes).

### What we already have, mapped against it

| capability | Dittofeed | us |
|---|---|---|
| marketing vs service/transactional survive independently | groups | **already ours** — `canContactPerson` gates by `purpose`; service reminders and signing mail are not touched by `marketingOptOut` |
| unsubscribe is one click, RFC 8058 headers | yes | **already ours** (`unsubscribeLinks.ts`) |
| consent audit trail | change events | **already ours**, stronger for POPIA — `ConsentRecord` is a ledger |
| per-channel marketing opt-out (email vs SMS separately) | yes | no — one `marketingOptOut` boolean kills both |
| preference centre | yes | no — our unsubscribe page is a kill switch with no way back or narrower choice |
| arbitrary named groups ("newsletter", "product news") | yes | no |
| groups as audience-rule operands | yes | no |
| one store of truth for the preference | one assignment table | **three overlapping stores** — `Contact.marketingOptOut`, latest `ConsentRecord`, and TWO `PortalPreference` flags; `communicationPolicy.ts` itself carries the "until they are consolidated" comment |

### The decision

**Do not port `SubscriptionGroup` as an entity.** Admin-defined groups are
machinery for senders running many distinct lists. Our tenants run one
marketing stream per channel; a groups admin screen would be surface area
without demand, and every eligibility check would grow a join for a
distinction nobody here expresses.

**Adopt three specific things, as follow-up work in this order:**

1. **Consolidate the three preference stores** onto `ConsentRecord` as the
   single truth (typed `marketing_email`, `marketing_sms`), with
   `marketingOptOut` kept as a derived, backwards-compatible read. This is our
   own recorded debt, and their design's real lesson is that ONE assignment
   store is what makes everything else cheap.
2. **Per-channel marketing opt-out**, which falls out of (1) — the unsubscribe
   route records `marketing_email` withdrawn instead of nuking both channels.
   An email unsubscribe silencing SMS is over-compliance that costs reach.
3. **A minimal preference page** on the existing unsubscribe route: after the
   one-click unsubscribe has already taken effect (compliance stays blunt and
   immediate — nothing is put behind a second click), show the per-channel
   state with the option to resubscribe or narrow. Token-authenticated by the
   existing recipient token; their HMAC scheme is only needed for links that
   outlive a campaign, which ours do not.

Not adopted: arbitrary groups, group-typed segments (until (1)–(3) exist and
someone asks), OptIn-typed groups (South African marketing consent is opt-out
per POPIA s69 for existing customers; our `ConsentRecord` already models
explicit grants where they are required).

---

## Item 4 completed: segment operator delta — written up (2026-09-01)

Read from `packages/isomorphic-lib/src/types.ts` (`SegmentOperatorType`,
`SegmentNodeType`) against `src/lib/marketingAudiences.ts`.

### The two vocabularies

**Ours**: `equals / not_equals / contains / in / is_empty / is_not_empty /
greater_than / greater_or_equal / less_than / less_or_equal` over contact
fields, composed with AND/OR groups and exclusions (depth ≤ 6, ≤ 100 rules) —
plus bespoke domain rules that are really pre-joined segments: `has_vehicle`,
`service_due`, `due_soon`, `overdue`, `won`, `bought_before`, `vehicle_model`,
`source`, `province`.

**Theirs**: trait operators `Equals / NotEquals / Exists / NotExists /
GreaterThanOrEqual / LessThan` plus **time** (`Within`, `HasBeen` — "has had
value X for ≥ N seconds", `AbsoluteTimestamp`) and **behavioural nodes**
(`Performed`, `LastPerformed`, `KeyedPerformed` — event counts and recency over
their ClickHouse event store), `Broadcast`, `Email` (engagement),
`RandomBucket`, `Manual`, `Everyone`, `Includes`.

### Where their set is genuinely richer, and what it is worth to us

| theirs | what it expresses | our position |
|---|---|---|
| `Within` / `AbsoluteTimestamp` | "created/changed in the last N days" | **worth adding** — we have no generic recency operator; `service_due` is the only time-aware rule and it is bespoke. One `within_days` operator over date fields covers "new contacts this month" and "no purchase since…" |
| `HasBeen` | "has been in state X for ≥ N days" | skip — expressible as `within_days` negation for every case a dealership has named |
| `Performed` family | event-based behaviour | skip the general mechanism — it is what their ClickHouse is FOR and we deliberately did not take that engine. The two behaviours worth having are engagement, below |
| `Email` engagement | opened / clicked | **worth adding** — we already RECORD `CampaignEvent` opens and clicks per contact and cannot segment on them. `opened_campaign` / `clicked_campaign` (any, or a named campaign) is a join we already own |
| `RandomBucket` | deterministic holdout % | **worth adding, cheapest of all** — a stable hash of contact id modulo 100 gives holdout groups for measuring whether campaigns work; no schema, no state |
| `SubscriptionGroup` nodes | groups in segments | follows the item-2 decision: not until groups exist |

**Decision:** three additive operators to `marketingAudiences.ts` when
marketing next gets attention — `within_days`, `opened_campaign` /
`clicked_campaign`, `random_bucket`. Each is a pure addition to
`ALLOWED_OPERATORS` + `compare`/query plumbing, none needs schema, and the
audience editor already renders arbitrary rules. Nothing else in their operator
set earns its keep against our data model.

---

**The queue is now fully dispositioned**: emailo delivered natively, MJML
superseded on the merits, subscription groups decided (consolidate → per-channel
→ preference page, no group entities), segment operators decided (three
operators, named). Follow-up build work is listed above by name; none of it is
blocked on further Dittofeed reading.

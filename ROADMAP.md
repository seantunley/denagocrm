# DenagoCRM Roadmap

Ideas agreed for later — not scheduled, in rough priority order.

## In progress (feature review 2026-07-08)

Being built now: **stock/inventory + purchase orders**, **parts + labour on job
cards**, **lead-source ROI + bulk campaigns**, and a **customer portal**. This
file tracks what was deliberately deferred from that review.

## Deferred from the 2026-07-08 feature review

### Money on the deal — deposits, balances & receivables (high value)

The quote tracks fulfilment *timestamps* (`invoicedAt`, `depositPaidAt`,
`deliveredAt`) and document uploads, but **no amounts**. Add deposit / balance /
payments-received to the quote, an "outstanding balances" (accounts-receivable)
report, and generate a real invoice PDF (not just an uploaded file). Smallest
lift, biggest daily payoff — do this next.

### Warranty with teeth

`Vehicle.warrantyMonths` exists but nothing uses it. Surface warranty expiry
(flag "expires in 6 weeks"), record what's covered, and log warranty claims.
For EVs the battery warranty is the whole ballgame.

### Battery health tracking (EV differentiator)

Per-vehicle battery serial, capacity, charge cycles and health over time — the
most valuable component on these carts. Feeds service upsells and warranty.

### Online deposit payment (SA gateway)

PayFast / Yoco / Ozow on the signing portal so a customer signs *and* pays the
deposit in one flow. Pairs with the deposits/balances work above.

### Accounting sync (Xero / Sage)

Push invoices + customers to accounting so the deal isn't captured twice.

## Older parked ideas (still open)

- **Full signing-portal wizard**: multi-step Review → Confirm details → Sign →
  Done, for longer contractual documents (sales agreements, finance). The current
  one-screen flow converts better for quick quote acceptance.
- **Social inbox — more channels**: YouTube comments (Data API), TikTok Lead Gen
  API. (Messenger, Instagram DMs and Google Reviews are done.)
- **WhatsApp bot phase 2**: swap the keyword matcher for a Claude answerer
  grounded in models/prices/policies, with human handoff on uncertainty.
- **Follow-up drip sequences**: multi-step nurture (approximated today with
  several idle-automation rules).
- **Borrow from Dittofeed** (MIT): MJML for responsive email HTML, their
  `emailo` low-code email editor, their subscription-group/unsubscribe model, and
  their segment operator set as comparison material. Their journey *engine* is
  deliberately not on the list — it runs on Temporal + ClickHouse + Kafka, which
  this deployment does not have. Scope, licence position and ordering are in
  [docs/dittofeed-borrow-queue.md](docs/dittofeed-borrow-queue.md).

## Shipped since this file was first written

Unified social inbox (Messenger/Instagram/Google Reviews), IMAP inbound email
onto the timeline, saved list views, module-based roles & permissions, AI assist
layer (proofread + research history), referral programme, deliveries board with
per-stage document uploads, user 2FA/session policy, System Log.

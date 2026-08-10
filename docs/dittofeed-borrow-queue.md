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

None of these is started. This document exists so the evaluation is not
re-litigated from scratch, and so the licence position is recorded next to the
decision rather than rediscovered later.

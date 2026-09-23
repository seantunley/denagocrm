# Why Neon is burning compute hours on an idle project

**23 September 2026** — ~100 compute hours since 7 September on a project with almost no traffic.

## The short version

The database is **never allowed to fall asleep**. The bill is wall-clock time, not work done.

Two cron routes run **every 5 minutes**, and both begin by running `SELECT 1` *specifically to wake a suspended
database* ([`src/lib/cronPreflight.ts`](../src/lib/cronPreflight.ts)). Neon's default autosuspend delay is
**5 minutes**. So the wake-up arrives at exactly the moment the compute would have suspended, 288 times a day,
forever — including 3am on a Sunday with nobody near the building.

## The arithmetic agrees

| | |
|---|---|
| 7 Sep → 23 Sep | 16 days = **384 hours** |
| Reported usage | **~100 compute hours** |
| Implied average size | 100 ÷ 384 = **0.26 CU** |
| Neon's minimum autoscale size | **0.25 CU** |
| 0.25 CU running 24/7 for 16 days | **96 compute hours** |

96 vs ~100. The compute is awake essentially **100% of the time at its minimum size**. That is the whole bill.
It is not query load, not a slow query, not a missing index — those would show as a *larger* average size, not
as permanent wakefulness at the floor.

> This is inferred from the numbers plus the code. **Verify in the Neon console** (below) before acting.

## What the crons actually do

From [`vercel.json`](../vercel.json). Every one of the first five calls `warmUpForCron`, which wakes the database
before doing anything — whether or not there is any work to do.

### Every 5 minutes — these are what keep it awake

| Route | What it does |
|---|---|
| `signing-jobs` | Durable e-signature worker. Drains *transition* jobs (a signature, decline or approval that created or closed a request), then *completion* jobs — sends emails, advances signing workflows. |
| `bot-outbox` | Flushes the chatbot's outbound queue — WhatsApp / Messenger / Instagram / Telegram replies waiting to be sent. |

### Every 15 minutes

| Route | What it does |
|---|---|
| `journeys` | Marketing journey / lifecycle engine. |
| `automations` | The big one — ~15 phases in sequence: service reminders, signature-request reminders, stale signing-claim recovery, stranded-completion recovery, Meta lead sync, Google reviews sync, **IMAP inbound email sync**, activity reminders, AI auto-research, campaign queue, survey distribution queue, stock reservation expiry, repairs detectors. |
| `statistics` | Rolls up reporting statistics. |

### Daily / monthly — negligible cost

| Route | When | What it does |
|---|---|---|
| `backup` | 02:00 daily | DB backup to blob storage, purge trash, prune error log. |
| `photo-orphans` | 03:00 daily | Sweeps orphaned photo blobs. |
| `competitor-watch` | 05:00 daily | Competitor price/stock watch. |
| `security` | 06:00, 1st of month | Security runbook checks. |

**867 database wake-ups per day**, of which 864 come from the five frequent routes.

## The second contributor: open browser tabs

Separate from the crons, several pages re-render their server components on a timer while the tab is visible —
each refresh is a round of database queries:

| Page | Interval |
|---|---|
| `/messages`, `/messages/cases` (the PWA) | **30s** |
| `/inbox`, `/comments` | **60s** |
| `/leads/attention` | **60s** |

One person leaving the inbox or the messages PWA open keeps the database busy for the whole working day.
`AutoRefresh` does check `document.visibilityState`, so a genuinely backgrounded tab stops — but a visible,
idle tab does not.

This explains *working-hours* usage. The crons explain *nights and weekends*, which is what makes an idle
project bill like a busy one.

## What to check in the Neon console

Before changing anything, confirm the diagnosis:

1. **Branch → Compute → Autosuspend delay.** Expect 5 minutes (the default). This is the number that matters most.
2. **Compute size range.** If the minimum is above 0.25 CU, every awake second costs proportionally more.
3. **How many computes are running.** There is a production branch (`ep-patient-waterfall`) *and* a dev branch
   (`ep-soft-river`), plus one Neon branch per open pull request. Each has its own compute and its own hours.
   With ~7 PRs open, that is several endpoints that CI wakes on every push.
   (Preview branches *are* deleted on PR close, with an orphan sweeper — see `.github/workflows/preview-database.yml`.)
4. **Usage graph, split by endpoint.** This tells you whether prod alone accounts for the ~100 hours, or whether
   dev and preview branches are a meaningful share.

## Options, cheapest first

### 1. Drop autosuspend to 60 seconds — no code change

**Estimated saving: ~75–80%.** With the cron cadence unchanged, the compute would be awake roughly 60–70 seconds
out of every 5 minutes instead of all 300.

The code is already built for this: `warmUpForCron` exists precisely to wake a sleeping database, with retries, a
wake-up budget and a "skip this run if waking took too long" path. Suspending more aggressively is the case it was
written for.

**Trade-off:** more cold starts (a few hundred ms) for whoever loads the CRM after a quiet spell. For an internal
CRM this is usually imperceptible; on a customer-facing public page it would matter more.

### 2. Slow the two 5-minute crons — one-line change each

**Estimated saving: a further ~10–15%** on top of option 1 (awake ~65s per 15 min rather than per 5 min).

- `signing-jobs` → `*/15`. Signing emails arrive up to 15 minutes later. Almost certainly fine.
- `bot-outbox` → **leave at 5 minutes.** This is the chatbot replying to customers on WhatsApp; a 15-minute
  delay on an automated reply is a product regression, not a saving.

Doing only `signing-jobs` still widens the gap the compute gets to sleep in for half the wake-ups.

### 3. Lengthen the in-app refresh intervals

`/messages` at 30s is aggressive for a queue that changes a few times a day. 60–120s would cut working-hours
database traffic meaningfully and nobody would notice.

### 4. Confirm the minimum compute size is 0.25 CU

The arithmetic suggests it already is, so there is probably nothing to win here — but it is worth one look,
because it multiplies everything else.

## What I would not do

- **Don't remove the `warmUpForCron` wake-up.** It is not the bug. Without it, a cron that fires against a cold
  database spends its entire budget on the connection and gets killed part-way through sending. The problem is the
  *cadence* it wakes at, not that it wakes.
- **Don't chase query optimisation.** At 0.26 CU average the compute is idling, not straining. There is no slow
  query to find.

## What was actually done (23 Sep)

Autosuspend set to **60 seconds**, and the cron cadence changed:

| Route | Was | Now |
|---|---|---|
| `bot-outbox` | 5 min | **5 min — unchanged** (chatbot replying to customers) |
| `signing-jobs` | 5 min | 15 min |
| `journeys` | 15 min | 30 min |
| `automations` | 15 min | 30 min |
| `statistics` | 15 min | 30 min |

### Projected effect

`bot-outbox` stays at five minutes, so **it alone sets the wake cadence** — the
database is dragged up 12 times an hour regardless of what the other jobs do.
Each wake costs roughly the work (a few seconds) plus the 60-second autosuspend
delay, so about **70 seconds awake per 5 minutes ≈ 23% duty cycle**.

| | Compute hours/day @ 0.25 CU | Per 30 days |
|---|---|---|
| Before (never suspends) | **6.0** | ~180 |
| After | **~1.4** | **~41** |
| *(if `bot-outbox` also moved to 15 min)* | *~0.5* | *~14* |

**Estimated saving: ~75%.** The other cron changes contribute only a little on
their own — they shorten some wakes and remove work, but they cannot create gaps
longer than five minutes while `bot-outbox` keeps that beat. Keeping prompt
chatbot replies costs roughly **27 compute hours a month**; that is the price of
the decision, and it is a reasonable one.

### The next ceiling: open browser tabs

Once the database is allowed to suspend, the in-app refresh timers become the
dominant cost during working hours. A visible `/messages` tab re-queries every
**30 seconds** — comfortably inside the 60-second autosuspend delay, so the
database simply never sleeps while somebody is looking at that page.

One person with `/messages` open for an 8-hour day is **~2.0 compute hours** —
more than the entire cron schedule now costs in a day. If the bill stays high
after this change, that is where to look next, and the fix is to lengthen those
intervals (30s → 120s on `/messages`, 60s → 180s on `/inbox` and `/comments`),
not to touch the crons again.

## Recommended order

1. Verify autosuspend and compute size in the console. ✅
2. Set autosuspend to 60s. Watch for two days.
3. If still high, the open-tab refresh intervals are the remaining driver.

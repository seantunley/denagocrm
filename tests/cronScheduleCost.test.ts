import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

type Cron = { path: string; schedule: string };
const crons = (JSON.parse(src("vercel.json")) as { crons: Cron[] }).crons;
const scheduleOf = (route: string) => crons.find((cron) => cron.path === `/api/cron/${route}`)?.schedule;

/**
 * THE CRON CADENCE IS A BILL, NOT A PREFERENCE.
 *
 * Every frequent cron starts by running `SELECT 1` to WAKE a suspended database
 * (lib/cronPreflight.ts). Neon bills compute by wall-clock time awake, so the
 * shortest interval in vercel.json decides how often the database is dragged
 * back up — and if that interval is shorter than the autosuspend delay, the
 * database never sleeps at all and bills 24/7 whether or not anyone is working.
 *
 * That is not hypothetical. With two crons on a five-minute schedule against
 * Neon's default 5-minute autosuspend, an idle project burned ~100 compute hours in
 * 16 days — 0.25 CU (the minimum size) awake ~100% of the time. See
 * docs/neon-compute-2026-09-23.md.
 *
 * The fix was autosuspend 60s + these intervals. These tests exist because the
 * saving is undone by a one-line change in a file nobody reviews for cost.
 */

test("THE SHORTEST INTERVAL IS WHAT THE DATABASE COSTS", () => {
  /*
   * bot-outbox is DELIBERATELY the only sub-15-minute cron: it is the chatbot
   * replying to customers on WhatsApp, and a slower queue is a visible product
   * regression. It alone therefore sets the wake cadence — roughly a minute
   * awake (the 60s autosuspend delay) every five, about a fifth of the day.
   *
   * Adding a SECOND five-minute cron would not make things twice as bad, it
   * would make them no better than before if it landed on the off-beat minutes: the
   * gaps are what let the database sleep, and a new job that fills them takes
   * the saving back to zero. That is the regression this test exists to catch.
   */
  const frequent = crons.filter((cron) => /^\*\/(\d+) \* \* \* \*$/.test(cron.schedule));
  const minutes = (cron: Cron) => Number(/^\*\/(\d+)/.exec(cron.schedule)![1]);

  const subQuarterHour = frequent.filter((cron) => minutes(cron) < 15);
  assert.deepEqual(
    subQuarterHour.map((cron) => cron.path),
    ["/api/cron/bot-outbox"],
    "bot-outbox is the ONLY cron allowed to run more often than every 15 minutes — " +
      "anything else joining it fills the gaps the database sleeps in. If this is a " +
      "deliberate product decision, change the test and the cost note with it.",
  );
});

test("THE INTERVALS ARE THE ONES THE COST NOTE ASSUMES", () => {
  assert.equal(scheduleOf("bot-outbox"), "*/5 * * * *", "chatbot replies stay prompt");
  assert.equal(scheduleOf("signing-jobs"), "*/15 * * * *", "signing email may wait a quarter hour");
  for (const route of ["journeys", "automations", "statistics"]) {
    assert.equal(scheduleOf(route), "*/30 * * * *", `${route} is not realtime`);
  }

  // The daily/monthly jobs cost nothing worth reasoning about — pinned only so
  // that a stray edit turning one into a frequent job is noticed here.
  assert.equal(scheduleOf("backup"), "0 2 * * *");
  assert.equal(scheduleOf("photo-orphans"), "0 3 * * *");
  assert.equal(scheduleOf("competitor-watch"), "0 5 * * *");
  assert.equal(scheduleOf("security"), "0 6 1 * *");
});

test("EVERY FREQUENT CRON STILL WAKES THE DATABASE ON PURPOSE", () => {
  /*
   * The wake-up is NOT the bug and must not be "optimised" away: without it a
   * cron firing against a cold database spends its whole budget on the
   * connection and is killed part-way through sending. The cost lever is the
   * INTERVAL, not the warm-up. This pins that distinction so the next person
   * reading the bill removes the right thing.
   */
  for (const route of ["bot-outbox", "signing-jobs", "journeys", "automations", "statistics"]) {
    const code = src(`src/app/api/cron/${route}/route.ts`);
    assert.match(code, /warmUpForCron\(/, `${route} wakes the database before sweeping`);
  }
});

test("NOTHING STILL TELLS A CUSTOMER THE OLD CADENCE", () => {
  /*
   * The IMAP note on the settings screen is read by the person wondering why a
   * reply has not appeared yet. It stated 15 minutes; the sweep that does it —
   * the imap-sync phase of `automations` — now runs every 30.
   */
  const settings = src("src/app/(app)/settings/page.tsx");
  assert.match(settings, /checked every 30 minutes/, "the IMAP note matches the automations cron");
  assert.ok(
    !/checked every 15 minutes/.test(settings),
    "no screen promises the old 15-minute inbox sweep",
  );
});

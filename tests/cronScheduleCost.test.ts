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

test("NOTHING RUNS MORE OFTEN THAN EVERY QUARTER HOUR", () => {
  /*
   * The shortest interval in this file IS the database bill. Whatever runs
   * most often decides how often the compute is dragged awake, and the gaps
   * between runs are the only time it gets to sleep — so ONE fast cron undoes
   * the saving no matter how leisurely everything else is.
   *
   * Fifteen minutes is the floor because, with a 60-second autosuspend delay,
   * it leaves roughly thirteen minutes of sleep in every quarter hour. A single
   * five-minute job would cut that to four, and take a ~92% saving back to
   * ~78% on its own.
   *
   * Nothing here needs to be faster. Bot replies and staff replies are sent
   * inline on the webhook that prompted them; these crons are recovery and
   * batch work. If something genuinely does need a shorter interval, that is a
   * real decision with a real monthly cost — change this test deliberately and
   * update docs/neon-compute-2026-09-23.md with the new arithmetic.
   */
  const minutes = (cron: Cron) => Number(/^\*\/(\d+)/.exec(cron.schedule)![1]);
  const tooFast = crons
    .filter((cron) => /^\*\/(\d+) \* \* \* \*$/.test(cron.schedule))
    .filter((cron) => minutes(cron) < 15);

  assert.deepEqual(
    tooFast.map((cron) => cron.path),
    [],
    "a cron running more often than every 15 minutes fills the gaps the database " +
      "sleeps in — see docs/neon-compute-2026-09-23.md before adding one",
  );
});

test("THE INTERVALS ARE THE ONES THE COST NOTE ASSUMES", () => {
  /*
   * signing-jobs is different in kind from the others: unlike the bot outbox it
   * has no inline path at all. runSigningJobs is called from this cron and
   * nowhere else, so when somebody signs, the next signer's "your turn" email
   * does not exist until the cron runs. Its interval is customer-visible
   * latency, not a recovery window.
   *
   * It runs every 30 minutes anyway, by decision. Neon's plan fixes the
   * scale-to-zero delay at 5 minutes, so each wake keeps the database up for
   * ~5 minutes; at 15 minutes this one job held the database awake ~35% of the
   * day, at 30 it is ~18% — about 30 compute hours a month, bought with signing
   * emails that may take up to half an hour. Tightening it again is a real
   * cost, not a free tweak.
   */
  for (const route of ["signing-jobs", "bot-outbox", "journeys", "automations", "statistics", "research"]) {
    assert.equal(scheduleOf(route), "*/30 * * * *", `${route} is recovery or batch work, not realtime`);
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
  for (const route of ["bot-outbox", "signing-jobs", "journeys", "automations", "statistics", "research"]) {
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

test("AUTOMATIC RESEARCH HAS ITS OWN JOB, SO A SLOW CALL CANNOT KILL THE SENDING QUEUES", () => {
  /*
   * A research call on the ChatGPT subscription measured 50 to 80 seconds. As a
   * phase of /api/cron/automations — killed at 60 — one new lead would have
   * taken down the campaign and survey queues that run after it.
   */
  const automations = src("src/app/api/cron/automations/route.ts");
  const automationsCode = automations.replace(/\/\/[^\n]*/g, "");
  assert.ok(!/runAutoResearch/.test(automationsCode), "the sending job no longer runs research");

  const research = src("src/app/api/cron/research/route.ts");
  assert.match(research, /export const maxDuration = 300;/, "the research job has Vercel's full five minutes");
  assert.match(research, /runAutoResearch\(budget\)/, "and hands the sweep its budget");
  assert.match(research, /warmUpForCron\("research"/);

  const ai = src("src/lib/ai.ts");
  const sweep = ai.slice(ai.indexOf("export async function runAutoResearch"));
  const guardAt = sweep.indexOf("if (budget?.shouldStop(AUTO_RESEARCH_RESERVE_MS)) break;");
  const callAt = sweep.indexOf("await aiResearch(");
  assert.ok(guardAt > 0 && callAt > guardAt, "a lead is only started with time to finish it");
});

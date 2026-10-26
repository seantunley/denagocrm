import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { jobFacts, vehicleWorkshop, workshopSummary, type FleetVehicle } from "../src/lib/workshopRules";
import { parseStep, vehicleArgs } from "../src/lib/crmAssistantPlan";
import { selfKnowledge } from "../src/lib/assistantSoul";
import { briefQuestion } from "../src/lib/proactiveRules";

/*
 * DAX knows the workshop (Sean: "What's the service history and battery status of the Nomad XL for the Constantia
 * estate client?"). Every verdict comes from the helpers the CRM pages use; job cards and warranty claims only for
 * people with those grants; nothing at all when Automotive is off.
 */

const code = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const NOW = new Date("2026-10-26T08:00:00+02:00");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function cart(over: Partial<FleetVehicle> = {}): FleetVehicle {
  return {
    id: "v1", model: "Nomad XL", regNumber: "CA 123", owner: "Constantia Estate HOA",
    purchaseDate: daysAgo(400), warrantyMonths: 24, serviceIntervalKm: null, serviceIntervalMonths: null,
    serviceRecords: [], mileageLogs: [], batteryChecks: [],
    ...over,
  };
}

test("a customer's cart: service due, recent services, battery and warranty — as the pages say", () => {
  const v = cart({
    serviceRecords: [
      { serviceDate: daysAgo(200), km: 900, summary: "6-month service", nextDueKm: null, nextDueDate: daysAgo(10) },
      { serviceDate: daysAgo(380), km: 100, summary: "First service", nextDueKm: null, nextDueDate: null },
    ],
    mileageLogs: [{ km: 1500, recordedAt: daysAgo(3) }],
    batteryChecks: [
      { checkedAt: daysAgo(5), stateOfHealth: 55 },
      { checkedAt: daysAgo(185), stateOfHealth: 85 },
    ],
    jobCards: { total: 1, list: [{ id: "j1", number: 42, status: "approval", description: "Brakes squeal", openedAt: daysAgo(9), updatedAt: daysAgo(7) }] },
    warrantyClaims: { total: 1, list: [{ id: "w1", status: "open", description: "Battery capacity", claimedAt: daysAgo(2) }] },
  });
  const full = vehicleWorkshop(v, NOW, true) as Record<string, unknown>;
  assert.equal(full.service, "Overdue");
  assert.equal(full.serviceDaysLeft, -10);
  assert.equal(full.odometerKm, 1500);
  assert.match(String(full.battery), /Replacement candidate \(55% state of health\)/);
  assert.equal(full.batteryWarrantyClaimCandidate, true, "≤70% inside the warranty");
  assert.equal(full.warranty, "In warranty");
  assert.deepEqual((full.lastServices as unknown[]).length, 2);
  assert.equal(full.openJobCards, 1);
  assert.deepEqual((full.jobCardList as { jobCard: string; stage: string; daysSinceUpdate: number }[])[0], {
    jobCard: "#42", link: "/jobcards/j1", stage: "Approval", about: "Brakes squeal", opened: "2026-10-17", lastUpdate: "2026-10-19", daysSinceUpdate: 7,
  });
  assert.equal(full.jobCardListNote, undefined, "the whole list — no note");
  assert.equal(full.openWarrantyClaims, 1);
  assert.equal((full.warrantyClaimList as { link: string }[])[0].link, "/warranty/w1");

  // A long list stays small: verdicts and counts only.
  const compact = vehicleWorkshop(v, NOW, false) as Record<string, unknown>;
  assert.equal(compact.openJobCards, 1);
  assert.equal(compact.lastServices, undefined);
  assert.equal(compact.jobCardList, undefined);
});

test("counts are the true totals, not the capped list's length — and a capped list says so", () => {
  const job = (n: number) => ({ id: `j${n}`, number: n, status: "repair", description: "d", openedAt: daysAgo(n), updatedAt: daysAgo(n) });
  const claim = (n: number) => ({ id: `w${n}`, status: "open", description: "c", claimedAt: daysAgo(n) });
  const v = cart({
    jobCards: { total: 7, list: [1, 2, 3, 4, 5].map(job) },
    warrantyClaims: { total: 6, list: [1, 2, 3, 4, 5].map(claim) },
  });
  const full = vehicleWorkshop(v, NOW, true) as Record<string, unknown>;
  assert.equal(full.openJobCards, 7);
  assert.equal((full.jobCardList as unknown[]).length, 5);
  assert.equal(full.jobCardListNote, "the newest 5 of 7");
  assert.equal(full.openWarrantyClaims, 6);
  assert.equal(full.warrantyClaimListNote, "the newest 5 of 6");
  const compact = vehicleWorkshop(v, NOW, false) as Record<string, unknown>;
  assert.equal(compact.openJobCards, 7);
  assert.equal(compact.openWarrantyClaims, 6);
  // The loader feeds `total` from a filtered _count with the SAME filter as the capped list.
  const ctx = code("src/lib/workshopContext.ts");
  assert.match(ctx, /jobCards: \{\s*where: openJobs,\s*orderBy: \{ openedAt: "desc" \},\s*take: LIST_CAP,/);
  assert.match(ctx, /warrantyClaims: \{\s*where: openClaims,\s*orderBy: \{ claimedAt: "desc" \},\s*take: LIST_CAP,/);
  assert.match(ctx, /_count: \{ select: \{ jobCards: \{ where: openJobs \}, warrantyClaims: \{ where: openClaims \} \} \}/);
  assert.match(ctx, /jobCards: access\.jobs === false \? undefined : \{ total: v\._count\.jobCards, list: v\.jobCards \}/);
  assert.match(ctx, /warrantyClaims: access\.claims \? \{ total: v\._count\.warrantyClaims, list: v\.warrantyClaims \} : undefined/);
  // Workshop overview totals: every accessible vehicle and every stuck job card is loaded, so `total` is the full count.
  assert.match(ctx, /total: stuck\.length,\s*top: stuck\.slice\(0, opts\.take\)/);
  assert.doesNotMatch(ctx.slice(ctx.indexOf("export async function workshopOverview")), /take: (?!number|1\b|6\b)/, "no hidden cap under the overview's totals");
});

test("each customer vehicle carries its id, for a proposed job card (PR #911)", () => {
  assert.match(code("src/lib/workshopContext.ts"), /vehicle: v\.model, vehicleId: v\.id, link: `\/vehicles\/\$\{v\.id\}`/);
});

test("job cards and claims they may not see are left out, not reported as none", () => {
  const facts = vehicleWorkshop(cart(), NOW, true) as Record<string, unknown>;
  assert.ok(!("openJobCards" in facts));
  assert.ok(!("openWarrantyClaims" in facts));
  assert.equal(facts.service, "Unknown", "no intervals, no service yet");
});

test("the workshop at a glance: overdue first, warranties ending ≤30 days, batteries to replace", () => {
  const fleet = [
    cart({ id: "a", serviceRecords: [{ serviceDate: daysAgo(100), km: 0, summary: "s", nextDueKm: null, nextDueDate: daysAgo(2) }] }),
    cart({ id: "b", serviceRecords: [{ serviceDate: daysAgo(100), km: 0, summary: "s", nextDueKm: null, nextDueDate: daysAgo(30) }] }),
    cart({ id: "c", serviceRecords: [{ serviceDate: daysAgo(100), km: 0, summary: "s", nextDueKm: null, nextDueDate: new Date(NOW.getTime() + 10 * 86_400_000) }] }),
    cart({ id: "d", purchaseDate: new Date("2024-11-10T00:00:00+02:00"), warrantyMonths: 24 }),
    cart({ id: "e", purchaseDate: new Date("2025-01-30T00:00:00+02:00"), warrantyMonths: 24 }),
    cart({ id: "f", batteryChecks: [{ checkedAt: daysAgo(1), stateOfHealth: 50 }] }),
  ];
  const s = workshopSummary(fleet, NOW, 1);
  assert.equal(s.servicesOverdue.total, 2);
  assert.equal((s.servicesOverdue.top[0] as { link: string }).link, "/vehicles/b", "most overdue first, as /service-due");
  assert.equal(s.servicesOverdue.top.length, 1, "capped at take");
  assert.equal(s.servicesDueSoon.total, 1);
  assert.equal(s.warrantiesEnding.total, 1, "15 days left counts, 96 days left does not");
  assert.equal((s.warrantiesEnding.top[0] as { link: string }).link, "/vehicles/d");
  assert.equal(s.batteryReplacementCandidates.total, 1);
  assert.equal((s.batteryReplacementCandidates.top[0] as { stateOfHealthPct: number }).stateOfHealthPct, 50);
});

test("jobFacts counts days since the last movement", () => {
  assert.equal(jobFacts({ id: "x", number: 7, status: "ready", description: "d", openedAt: daysAgo(20), updatedAt: daysAgo(6) }, NOW).daysSinceUpdate, 6);
  assert.equal(jobFacts({ id: "x", number: 7, status: "ready", description: "d", openedAt: daysAgo(20), updatedAt: daysAgo(6) }, NOW).stage, "Ready for collection");
});

test("the planner can ask for the workshop, and for a cart by owner, suburb or estate", () => {
  assert.deepEqual(parseStep('{"tool":"vehicles","args":{"kind":"workshop","stuckDays":7}}'), { tool: "vehicles", args: { kind: "workshop", stuckDays: 7 } });
  assert.equal(vehicleArgs.safeParse({ kind: "workshop", stuckDays: 0 }).success, false);
  const plan = code("src/lib/crmAssistantPlan.ts");
  assert.match(plan, /kind customer also gives each vehicle\\'s workshop picture/);
  assert.match(plan, /"Nomad XL Constantia"/);
});

test("workshop lookups go through the pages' own visibility rules", () => {
  const ctx = code("src/lib/workshopContext.ts");
  // Vehicles: the /vehicles scope. Job cards: their own grant and scope. Claims: the warranty grant.
  assert.match(ctx, /vehicles: vehicles \? await getAccessibleVehicleIds\(user\) : \(false as const\)/);
  assert.match(ctx, /hasAnyPermission\(user, "jobcards\.view_all", "jobcards\.view_owned"\)/);
  assert.match(ctx, /jobs: jobs \? await getAccessibleJobCardIds\(user\) : \(false as const\)/);
  assert.match(ctx, /hasAnyPermission\(user, \.\.\.WARRANTY_READ\)/);
  assert.match(ctx, /const openJobs = \{ \.\.\.\(access\.jobs === false \? NOTHING : inScope\(access\.jobs\)\), deletedAt: null, status: \{ notIn: CLOSED_JOB_STATUSES \} \};/);
  assert.match(ctx, /const openClaims = \{ \.\.\.\(access\.claims \? \{\} : NOTHING\), status: \{ in: OPEN_CLAIM_STATUSES \} \};/);
  assert.match(ctx, /jobCards: access\.jobs === false \? undefined : \{/);
  assert.match(ctx, /warrantyClaims: access\.claims \? \{[^}]*\} : undefined/);
  assert.match(ctx, /where: \{ deletedAt: null, \.\.\.inScope\(access\.vehicles\), \.\.\.\(words\.length/);
  // The tenant-scoped client only.
  assert.doesNotMatch(ctx, /basePrisma/);
  // Search: owner's company and address, the vehicle's fleet.
  assert.match(ctx, /company: fuzzy\(w\)/);
  assert.match(ctx, /suburb: fuzzy\(w\)/);
  assert.match(ctx, /fleet: \{ OR: \[\{ name: fuzzy\(w\) \}/);
  // Stuck = open (not collected/cancelled) with no update for N days.
  assert.match(ctx, /status: \{ notIn: CLOSED_JOB_STATUSES \},\s*updatedAt: \{ lt: new Date\(now\.getTime\(\) - opts\.stuckDays \* DAY\) \}/);
});

test("Automotive off: no workshop lookup, no workshop in the brief", () => {
  const lib = code("src/lib/crmAssistant.ts");
  const vehicles = lib.slice(lib.indexOf("async function vehicles("), lib.indexOf("\nasync function", lib.indexOf("async function vehicles(") + 10));
  assert.ok(
    vehicles.indexOf('isModuleEnabled("automotive")') < vehicles.indexOf('args.kind === "workshop"'),
    "the module check comes before the workshop and customer lookups",
  );
  const brief = lib.slice(lib.indexOf("async function dailyBrief("), lib.indexOf("\nfunction refused("));
  assert.match(brief, /isModuleEnabled\("automotive"\)\.then\(\(on\) => \(on \? workshopOverview\(user, \{ take: 3, stuckDays: 5, brief: true \}\) : null\)\)/);
  assert.match(brief, /if \(!sales && !workshop\) return refused\("leads"\);/);
  assert.match(brief, /const brief = sales \? await loadDaxBrief\(user\) : null;/);
  // Brief mode: empty sections dropped, nothing to say → no section.
  assert.match(code("src/lib/workshopContext.ts"), /if \(opts\.brief && Object\.keys\(data\)\.length === 0\) return null;/);

  const off = selfKnowledge("DAX", new Set(["core", "automation"]));
  assert.doesNotMatch(off, /workshop|job card|battery/i);
  assert.match(selfKnowledge("DAX", new Set(["core", "automotive"])), /the workshop as a whole/);
});

test("the morning brief includes the workshop section only when there is one", () => {
  const q = briefQuestion(NOW, []);
  assert.match(q, /If the daily brief has a workshop section, add a short Workshop part/);
  assert.match(q, /No workshop section, no Workshop part\./);
});

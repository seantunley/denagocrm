import { johannesburgDateKey } from "./activityDay";
import { analyzeBattery } from "./battery";
import { computeDue, dueLabels } from "./serviceDue";
import { computeWarranty, warrantyLabels } from "./warranty";
import { stageMeta } from "./workshop-constants";

/**
 * DAX's workshop facts — the PURE half (workshopContext.ts loads the rows).
 *
 * Every verdict comes from the helper the CRM's own pages use — computeDue
 * (/service-due), analyzeBattery and computeWarranty (the vehicle page) — so
 * DAX says what the pages say about the same cart, never its own guess.
 */

const DAY = 86_400_000;
/** Job cards that are finished: collected or cancelled (as /jobcards/insights counts "active"). */
export const CLOSED_JOB_STATUSES = ["collected", "cancelled"];
/** Warranty claims still being dealt with. */
export const OPEN_CLAIM_STATUSES = ["open", "approved"];
/** "Warranties running out" in the workshop view and the brief. */
export const WARRANTY_ENDING_DAYS = 30;
/** A search this short or shorter answers with full workshop detail per vehicle. */
export const FULL_DETAIL_MAX = 5;

const day = (d: Date | null | undefined) => (d ? johannesburgDateKey(d) : null);
const clip = (s: string | null | undefined, n: number) => (s ? (s.length > n ? `${s.slice(0, n)}…` : s) : null);

export type OpenJob = { id: string; number: number; status: string; description: string; openedAt: Date; updatedAt: Date };
export type OpenClaim = { id: string; status: string; description: string; claimedAt: Date };
export type WorkshopVehicle = {
  id: string;
  model: string;
  regNumber: string | null;
  purchaseDate: Date | null;
  warrantyMonths: number | null;
  serviceIntervalKm: number | null;
  serviceIntervalMonths: number | null;
  /** Newest first. */
  serviceRecords: { serviceDate: Date; km: number | null; summary: string; nextDueKm: number | null; nextDueDate: Date | null }[];
  /** Newest first. */
  mileageLogs: { km: number; recordedAt: Date }[];
  /** Newest first. */
  batteryChecks: { checkedAt: Date; stateOfHealth: number | null }[];
  /** Undefined: this person may not see job cards — say nothing about them. */
  jobCards?: OpenJob[];
  /** Undefined: this person may not see warranty claims. */
  warrantyClaims?: OpenClaim[];
};

export function jobFacts(j: OpenJob, now: Date) {
  return {
    jobCard: `#${j.number}`,
    link: `/jobcards/${j.id}`,
    stage: stageMeta(j.status).label,
    about: clip(j.description, 80),
    opened: day(j.openedAt),
    lastUpdate: day(j.updatedAt),
    daysSinceUpdate: Math.max(0, Math.floor((now.getTime() - j.updatedAt.getTime()) / DAY)),
  };
}

function verdicts(v: WorkshopVehicle, now: Date) {
  return {
    due: computeDue(v, now),
    battery: analyzeBattery(v.batteryChecks, { purchaseDate: v.purchaseDate, warrantyMonths: v.warrantyMonths, now }),
    warranty: computeWarranty(v, now),
  };
}

/**
 * One customer vehicle's workshop picture. `full` (a handful of vehicles) adds
 * the last services, the battery trend, and each open job card and claim;
 * otherwise just the verdicts, so a list of fifteen stays small.
 */
export function vehicleWorkshop(v: WorkshopVehicle, now: Date, full: boolean) {
  const { due, battery, warranty } = verdicts(v, now);
  const compact = {
    service: dueLabels[due.status],
    nextServiceDue: day(due.nextDueDate),
    ...(due.nextDueKm != null ? { nextServiceAtKm: due.nextDueKm } : {}),
    ...(due.currentKm != null ? { odometerKm: due.currentKm } : {}),
    // Negative = overdue by that much.
    ...(due.daysRemaining != null ? { serviceDaysLeft: due.daysRemaining } : {}),
    ...(due.kmRemaining != null ? { serviceKmLeft: due.kmRemaining } : {}),
    battery: battery.latestSoh == null ? battery.headline : `${battery.headline} (${battery.latestSoh}% state of health)`,
    warranty: warrantyLabels[warranty.status],
    warrantyUntil: day(warranty.expiryDate),
    ...(v.jobCards ? { openJobCards: v.jobCards.length } : {}),
    ...(v.warrantyClaims ? { openWarrantyClaims: v.warrantyClaims.length } : {}),
  };
  if (!full) return compact;
  return {
    ...compact,
    lastServices: v.serviceRecords.slice(0, 3).map((s) => ({ date: day(s.serviceDate), km: s.km, summary: clip(s.summary, 100) })),
    lastBatteryCheck: day(v.batteryChecks[0]?.checkedAt),
    ...(battery.degradationPerMonth != null ? { batteryHealthLostPerMonthPct: battery.degradationPerMonth } : {}),
    ...(battery.projectedMonthsToWarning != null ? { monthsUntilBatteryWarning: battery.projectedMonthsToWarning } : {}),
    ...(battery.warrantyEligible ? { batteryWarrantyClaimCandidate: true } : {}),
    ...(v.jobCards ? { openJobCards: v.jobCards.map((j) => jobFacts(j, now)) } : {}),
    ...(v.warrantyClaims
      ? { openWarrantyClaims: v.warrantyClaims.map((c) => ({ link: `/warranty/${c.id}`, status: c.status, about: clip(c.description, 80), claimed: day(c.claimedAt) })) }
      : {}),
  };
}

export type FleetVehicle = WorkshopVehicle & { owner: string | null };

/**
 * The workspace's workshop at a glance, from the vehicles this person may see:
 * services overdue and due soon (ordered as /service-due orders them), warranties
 * ending within 30 days, battery replacement candidates. Each list has its total
 * and the first `take`. Job cards are loaded separately (their own access rule).
 */
export function workshopSummary(vehicles: FleetVehicle[], now: Date, take: number) {
  const rows = vehicles.map((v) => ({ v, ...verdicts(v, now) }));
  const who = (v: FleetVehicle) => ({ vehicle: v.model, reg: v.regNumber, owner: v.owner, link: `/vehicles/${v.id}` });
  const list = <T>(items: T[], shape: (item: T) => object) => ({ total: items.length, top: items.slice(0, take).map(shape) });
  const byDays = (a: number | null, b: number | null) => (a ?? 1e9) - (b ?? 1e9);

  const services = rows
    .filter((r) => r.due.status === "overdue" || r.due.status === "due_soon")
    .sort((a, b) => byDays(a.due.daysRemaining, b.due.daysRemaining));
  const serviceRow = (r: (typeof rows)[number]) => ({
    ...who(r.v),
    due: day(r.due.nextDueDate),
    ...(r.due.daysRemaining != null ? { daysLeft: r.due.daysRemaining } : {}),
    ...(r.due.kmRemaining != null ? { kmLeft: r.due.kmRemaining } : {}),
    lastService: day(r.v.serviceRecords[0]?.serviceDate) ?? "never",
  });
  const ending = rows
    .filter((r) => r.warranty.daysRemaining != null && r.warranty.daysRemaining >= 0 && r.warranty.daysRemaining <= WARRANTY_ENDING_DAYS)
    .sort((a, b) => byDays(a.warranty.daysRemaining, b.warranty.daysRemaining));
  const batteries = rows
    .filter((r) => r.battery.replacementOpportunity)
    .sort((a, b) => (a.battery.latestSoh ?? 0) - (b.battery.latestSoh ?? 0));

  return {
    servicesOverdue: list(services.filter((r) => r.due.status === "overdue"), serviceRow),
    servicesDueSoon: list(services.filter((r) => r.due.status === "due_soon"), serviceRow),
    warrantiesEnding: list(ending, (r) => ({ ...who(r.v), warrantyUntil: day(r.warranty.expiryDate), daysLeft: r.warranty.daysRemaining })),
    batteryReplacementCandidates: list(batteries, (r) => ({ ...who(r.v), stateOfHealthPct: r.battery.latestSoh, lastCheck: day(r.v.batteryChecks[0]?.checkedAt) })),
  };
}

import "server-only";
import { prisma } from "./db";
import { johannesburgDateKey } from "./activityDay";
import { contactName } from "./format";
import { getAccessibleJobCardIds, getAccessibleVehicleIds, hasAnyPermission, type PermissionUser } from "./permissions";
import { WARRANTY_READ } from "./warrantyAccess";
import {
  CLOSED_JOB_STATUSES,
  FULL_DETAIL_MAX,
  OPEN_CLAIM_STATUSES,
  jobFacts,
  vehicleWorkshop,
  workshopSummary,
} from "./workshopRules";

/**
 * DAX's workshop lookups — the IMPURE half (workshopRules.ts decides).
 *
 * NEVER MORE THAN THEIR OWN PAGES: vehicles through getAccessibleVehicleIds (as
 * /vehicles and /service-due), job cards only with jobcards.view_* and through
 * getAccessibleJobCardIds (as /jobcards), warranty claims only with the warranty
 * grant (warrantyAccess) on a vehicle they can open. All on the tenant-scoped
 * client. The caller checks the Automotive module.
 */

const DAY = 86_400_000;
const fuzzy = (needle: string) => ({ contains: needle, mode: "insensitive" as const });
const inScope = (ids: string[] | null) => (ids === null ? {} : { id: { in: ids } });
/** Matches nothing: a relation this person may not see is still selected (one result type), but always empty. */
const NOTHING = { id: { in: [] as string[] } };
/** Open job cards / claims listed per vehicle; the counts beside them are the true totals. */
const LIST_CAP = 5;

type Row = { label: string; detail: string; href: string };

/** What of the workshop this person may see. `false` = not theirs; ids `null` = all in the workspace. */
async function workshopAccess(user: PermissionUser) {
  const [vehicles, jobs, claims] = await Promise.all([
    hasAnyPermission(user, "vehicles.view_all", "vehicles.view_owned"),
    hasAnyPermission(user, "jobcards.view_all", "jobcards.view_owned"),
    hasAnyPermission(user, ...WARRANTY_READ),
  ]);
  return {
    vehicles: vehicles ? await getAccessibleVehicleIds(user) : (false as const),
    jobs: jobs ? await getAccessibleJobCardIds(user) : (false as const),
    claims,
  };
}

const serviceSelect = { serviceDate: true, km: true, summary: true, nextDueKm: true, nextDueDate: true } as const;
const ownerSelect = { firstName: true, lastName: true, company: true, isCompany: true } as const;

/**
 * Customers' own vehicles with their workshop picture. The search matches every
 * word somewhere — model, reg, VIN, the owner's name, company, address, suburb or
 * city, or the vehicle's fleet (name or address) — so "Nomad XL Constantia" finds
 * the Nomad XL whose owner or estate is in Constantia.
 */
export async function customerVehicles(user: PermissionUser, args: { search?: string; limit?: number }, now = new Date()) {
  const take = args.limit ?? 15;
  const access = await workshopAccess(user);
  if (access.vehicles === false) return { truncated: false, rows: [] as Row[], data: [{ note: "You don't have access to customer vehicles." }] };
  const words = (args.search ?? "").split(/\s+/).filter((w) => w.length >= 2).slice(0, 6);
  const place = (w: string) => [{ address: fuzzy(w) }, { suburb: fuzzy(w) }, { city: fuzzy(w) }];
  const matches = (w: string) => ({
    OR: [
      { model: fuzzy(w) },
      { regNumber: fuzzy(w) },
      { vin: fuzzy(w) },
      { contact: { OR: [{ firstName: fuzzy(w) }, { lastName: fuzzy(w) }, { company: fuzzy(w) }, ...place(w)] } },
      { fleet: { OR: [{ name: fuzzy(w) }, ...place(w)] } },
    ],
  });
  // One filter each for the list AND its count, so the count is the true total, not the capped list's length.
  const openJobs = { ...(access.jobs === false ? NOTHING : inScope(access.jobs)), deletedAt: null, status: { notIn: CLOSED_JOB_STATUSES } };
  const openClaims = { ...(access.claims ? {} : NOTHING), status: { in: OPEN_CLAIM_STATUSES } };
  const found = await prisma.vehicle.findMany({
    where: { deletedAt: null, ...inScope(access.vehicles), ...(words.length ? { AND: words.map(matches) } : {}) },
    orderBy: { createdAt: "desc" },
    take: take + 1,
    select: {
      id: true, model: true, regNumber: true, color: true, purchaseDate: true, warrantyMonths: true,
      serviceIntervalKm: true, serviceIntervalMonths: true,
      contact: { select: { ...ownerSelect, suburb: true } },
      fleet: { select: { name: true } },
      serviceRecords: { orderBy: { serviceDate: "desc" }, take: 3, select: serviceSelect },
      mileageLogs: { orderBy: { recordedAt: "desc" }, take: 1, select: { km: true, recordedAt: true } },
      batteryChecks: { orderBy: { checkedAt: "desc" }, take: 6, select: { checkedAt: true, stateOfHealth: true } },
      jobCards: {
        where: openJobs,
        orderBy: { openedAt: "desc" },
        take: LIST_CAP,
        select: { id: true, number: true, status: true, description: true, openedAt: true, updatedAt: true },
      },
      warrantyClaims: {
        where: openClaims,
        orderBy: { claimedAt: "desc" },
        take: LIST_CAP,
        select: { id: true, status: true, description: true, claimedAt: true },
      },
      _count: { select: { jobCards: { where: openJobs }, warrantyClaims: { where: openClaims } } },
    },
  });
  const page = found.slice(0, take);
  const full = page.length <= FULL_DETAIL_MAX;
  return {
    truncated: found.length > take,
    data: page.map((v) => ({
      // vehicleId: what a proposed job card (assistantActions job_card) names the vehicle by.
      vehicle: v.model, vehicleId: v.id, link: `/vehicles/${v.id}`, reg: v.regNumber, colour: v.color,
      owner: contactName(v.contact), suburb: v.contact.suburb, fleet: v.fleet?.name ?? null,
      bought: v.purchaseDate ? johannesburgDateKey(v.purchaseDate) : null,
      ...vehicleWorkshop(
        {
          ...v,
          // Not theirs to see → undefined, so DAX says nothing rather than "none".
          jobCards: access.jobs === false ? undefined : { total: v._count.jobCards, list: v.jobCards },
          warrantyClaims: access.claims ? { total: v._count.warrantyClaims, list: v.warrantyClaims } : undefined,
        },
        now,
        full,
      ),
    })),
    rows: page.map((v) => ({ label: `${v.model} — ${contactName(v.contact)}`, detail: v.regNumber ?? "no reg", href: `/vehicles/${v.id}` })),
  };
}

/**
 * The workshop as a whole: services overdue / due soon, job cards with no
 * movement for `stuckDays`, warranties ending within 30 days, battery
 * replacement candidates. `brief`: only what needs doing today (overdue
 * services, stuck job cards, warranties ending), empty lists left out — the
 * morning brief's workshop section. Null when this person may see neither
 * vehicles nor job cards (or, for the brief, when there is nothing to say).
 */
export async function workshopOverview(
  user: PermissionUser,
  opts: { take: number; stuckDays: number; brief?: boolean },
  now = new Date(),
): Promise<{ data: Record<string, unknown>; rows: Row[] } | null> {
  const access = await workshopAccess(user);
  if (access.vehicles === false && access.jobs === false) return null;
  const [fleet, stuck] = await Promise.all([
    access.vehicles === false
      ? null
      // ponytail: every accessible vehicle in memory, as /service-due does; move the due maths into SQL if a fleet outgrows it.
      : prisma.vehicle.findMany({
          where: { deletedAt: null, ...inScope(access.vehicles) },
          select: {
            id: true, model: true, regNumber: true, purchaseDate: true, warrantyMonths: true,
            serviceIntervalKm: true, serviceIntervalMonths: true,
            contact: { select: ownerSelect },
            serviceRecords: { orderBy: { serviceDate: "desc" }, take: 1, select: serviceSelect },
            mileageLogs: { orderBy: { recordedAt: "desc" }, take: 1, select: { km: true, recordedAt: true } },
            batteryChecks: { orderBy: { checkedAt: "desc" }, take: 6, select: { checkedAt: true, stateOfHealth: true } },
          },
        }),
    access.jobs === false
      ? null
      : prisma.jobCard.findMany({
          where: {
            ...inScope(access.jobs),
            deletedAt: null,
            status: { notIn: CLOSED_JOB_STATUSES },
            updatedAt: { lt: new Date(now.getTime() - opts.stuckDays * DAY) },
          },
          orderBy: { updatedAt: "asc" },
          select: {
            id: true, number: true, status: true, description: true, openedAt: true, updatedAt: true,
            vehicle: { select: { model: true, regNumber: true } },
            contact: { select: ownerSelect },
          },
        }),
  ]);

  const summary = fleet ? workshopSummary(fleet.map((v) => ({ ...v, owner: contactName(v.contact) })), now, opts.take) : null;
  const stuckJobCards = stuck
    ? {
        noMovementForDays: opts.stuckDays,
        total: stuck.length,
        top: stuck.slice(0, opts.take).map((j) => ({ ...jobFacts(j, now), vehicle: j.vehicle.model, reg: j.vehicle.regNumber, customer: contactName(j.contact) })),
      }
    : null;

  const sections: Record<string, { total: number; top: unknown[] } | null> = opts.brief
    ? { servicesOverdue: summary?.servicesOverdue ?? null, stuckJobCards, warrantiesEnding: summary?.warrantiesEnding ?? null }
    : { ...summary, stuckJobCards };
  const data = Object.fromEntries(Object.entries(sections).filter(([, s]) => s && (!opts.brief || s.total > 0)));
  if (opts.brief && Object.keys(data).length === 0) return null;

  const rows: Row[] = [];
  if (summary) {
    rows.push({ label: "Service due", detail: `${summary.servicesOverdue.total} overdue · ${summary.servicesDueSoon.total} due soon`, href: "/service-due" });
  }
  if (stuckJobCards) rows.push({ label: "Job cards", detail: `${stuckJobCards.total} with no movement for ${opts.stuckDays}+ days`, href: "/jobcards" });
  return { data, rows };
}

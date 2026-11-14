import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { ownedWriteTenantId } from "./tenantWrite";
import { getAccessibleLeadIds, hasAnyPermission, type PermissionUser } from "./permissions";
import { isModuleEnabled } from "./modules/enabled";
import { accessibleTestDriveWhere } from "./testDriveAccess";
import { testDriveStatusLabel } from "./testDriveMetrics";
import { contactName } from "./format";

/**
 * TEST DRIVES, past and upcoming (Sean, 2026-11-14: "DAX must have knowledge of those things, permission based").
 *
 * HELD TO THE /test-drives PAGE'S OWN RULE: the Automotive module, activities.view or .manage, and the page's own
 * booking scope (accessibleTestDriveWhere: the customer or deal is theirs to open, or they ran the drive). Whether the
 * customer later BOUGHT is named only from a won deal the person may open (getAccessibleLeadIds), or the drive's own
 * recorded outcome. The workspace is named in every query.
 *
 * NEVER READ: the driver's licence number or expiry, identity checks, emergency contact, uploaded files (licence
 * images), damage and incident reports. Nothing here is logged.
 */

type Output = { rows: { label: string; detail: string; href: string }[]; data: unknown[]; truncated: boolean };
export type TestDrivesArgs = { from?: string; to?: string; customer?: string; vehicle?: string; outcome?: string; boughtAfter?: boolean; limit?: number };

const DAY = 86_400_000;
const READ = 500;
const unavailable = (why: string): Output => ({ rows: [], data: [{ note: why }], truncated: false });
const clip = (s: string | null | undefined, max: number) => {
  const text = (s ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};
const fuzzy = (needle: string) => ({ contains: needle, mode: "insensitive" as const });
const saDay = (d: Date) => new Date(d.getTime() + 2 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");

export async function testDrivesLookup(user: PermissionUser, args: TestDrivesArgs): Promise<Output> {
  if (!(await isModuleEnabled("automotive"))) return unavailable("Test drives are part of the Automotive module, which is switched off in this workspace.");
  if (!(await hasAnyPermission(user, "activities.view", "activities.manage"))) return unavailable("This person can't open test drives.");
  const tenantId = ownedWriteTenantId();
  const [scope, leadIds] = await Promise.all([accessibleTestDriveWhere(user), getAccessibleLeadIds(user)]);

  // Default: the last 90 days and the next 30 — "past and upcoming".
  const from = args.from ? new Date(`${args.from}T00:00:00+02:00`) : new Date(Date.now() - 90 * DAY);
  const to = args.to ? new Date(new Date(`${args.to}T00:00:00+02:00`).getTime() + DAY) : new Date(Date.now() + 30 * DAY);
  const words = (s?: string) => (s ?? "").split(/\s+/).filter(Boolean).slice(0, 4);
  const [customers, products] = await Promise.all([
    args.customer
      ? prisma.contact.findMany({
          where: { tenantId, deletedAt: null, AND: words(args.customer).map((w) => ({ OR: [{ firstName: fuzzy(w) }, { lastName: fuzzy(w) }, { company: fuzzy(w) }] })) },
          select: { id: true },
          take: 200,
        })
      : null,
    args.vehicle ? prisma.product.findMany({ where: { tenantId, name: fuzzy(args.vehicle) }, select: { id: true }, take: 50 }) : null,
  ]);
  const where: Prisma.TestDriveBookingWhereInput = {
    tenantId,
    deletedAt: null,
    scheduledStart: { gte: from, lt: to },
    // AND, never spread: the page's scope must not be replaced by what was asked for.
    AND: [
      scope,
      ...(customers ? [{ contactId: { in: customers.map((c) => c.id) } }] : []),
      ...(args.vehicle
        ? [{ OR: [{ demoVehicle: { name: fuzzy(args.vehicle) } }, { demoVehicle: { regNumber: fuzzy(args.vehicle) } }, { productId: { in: (products ?? []).map((p) => p.id) } }] }]
        : []),
      ...(args.outcome ? [{ OR: [{ salesOutcome: fuzzy(args.outcome) }, { status: fuzzy(args.outcome) }] }] : []),
    ],
  };
  const [count, drives] = await Promise.all([
    prisma.testDriveBooking.count({ where }),
    prisma.testDriveBooking.findMany({
      where,
      orderBy: { scheduledStart: "desc" },
      take: READ,
      select: {
        id: true, reference: true, status: true, contactId: true, leadId: true, productId: true, salespersonId: true,
        scheduledStart: true, actualReturnAt: true, salesOutcome: true, customerFeedback: true, convertedQuoteId: true,
        demoVehicle: { select: { name: true, regNumber: true } },
      },
    }),
  ]);

  const contactIds = [...new Set(drives.map((d) => d.contactId))];
  const [contacts, productRows, staff, won] = await Promise.all([
    prisma.contact.findMany({ where: { tenantId, id: { in: contactIds } }, select: { id: true, firstName: true, lastName: true, company: true, isCompany: true } }),
    prisma.product.findMany({ where: { tenantId, id: { in: [...new Set(drives.map((d) => d.productId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } }),
    prisma.user.findMany({ where: { id: { in: [...new Set(drives.map((d) => d.salespersonId))] } }, select: { id: true, name: true } }),
    // Won deals on these customers that THIS person may open — "did they buy?".
    contactIds.length
      ? prisma.lead.findMany({
          where: { tenantId, deletedAt: null, status: "won", contactId: { in: contactIds }, AND: [leadIds === null ? {} : { id: { in: leadIds } }] },
          select: { id: true, contactId: true, title: true, wonAt: true },
        })
      : [],
  ]);
  const name = new Map(contacts.map((c) => [c.id, contactName(c)]));
  const product = new Map(productRows.map((p) => [p.id, p.name]));
  const person = new Map(staff.map((s) => [s.id, s.name]));
  const boughtAfter = (d: (typeof drives)[number]) =>
    won.find((l) => l.contactId === d.contactId && l.wonAt && l.wonAt.getTime() >= d.scheduledStart.getTime()) ?? null;
  const bought = (d: (typeof drives)[number]) => d.salesOutcome === "sale_won" || Boolean(boughtAfter(d));

  // ponytail: "bought" is worked out on the newest READ drives; past that the total is a floor.
  const filtered = args.boughtAfter === undefined ? drives : drives.filter((d) => bought(d) === args.boughtAfter);
  const total = args.boughtAfter === undefined ? count : count > READ ? `at least ${filtered.length}` : filtered.length;
  const take = Math.min(args.limit ?? 15, 60);
  const page = filtered.slice(0, take);
  const now = Date.now();
  return {
    truncated: filtered.length > take || count > READ,
    data: [
      { total, listed: page.length, period: `${saDay(from).slice(0, 10)} to ${saDay(new Date(to.getTime() - DAY)).slice(0, 10)}` },
      ...page.map((d) => {
        const deal = boughtAfter(d);
        return {
          reference: d.reference,
          link: `/test-drives/${d.id}`,
          customer: name.get(d.contactId) ?? "a customer",
          vehicle: [d.demoVehicle?.name, d.demoVehicle?.regNumber].filter(Boolean).join(" · ") || (d.productId ? product.get(d.productId) ?? null : null),
          product: d.productId ? product.get(d.productId) ?? null : null,
          when: saDay(d.scheduledStart),
          upcoming: d.scheduledStart.getTime() > now,
          status: testDriveStatusLabel(d.status),
          ranBy: person.get(d.salespersonId) ?? "someone",
          outcome: d.salesOutcome?.replaceAll("_", " ") ?? null,
          feedback: d.customerFeedback ? clip(d.customerFeedback, 240) : null,
          quoteCreated: Boolean(d.convertedQuoteId),
          bought: bought(d),
          ...(deal ? { wonDeal: { title: deal.title, link: `/leads/${deal.id}`, won: deal.wonAt?.toISOString().slice(0, 10) } } : {}),
        };
      }),
    ],
    rows: page.map((d) => ({
      label: `${name.get(d.contactId) ?? "Test drive"} — ${d.demoVehicle?.name ?? (d.productId ? product.get(d.productId) : null) ?? d.reference}`,
      detail: `${saDay(d.scheduledStart)} · ${testDriveStatusLabel(d.status)}${d.salesOutcome ? ` · ${d.salesOutcome.replaceAll("_", " ")}` : ""}`,
      href: `/test-drives/${d.id}`,
    })),
  };
}

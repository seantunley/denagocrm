import "server-only";
import type { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { ownedWriteTenantId } from "./tenantWrite";
import { getAccessibleContactIds, hasAnyPermission, type PermissionUser } from "./permissions";
import { isModuleEnabled } from "./modules/enabled";
import { contactName } from "./format";
import { birthdayKeys, formatBirthday, nextDays } from "./birthdays";
import type { customersArgs } from "./crmAssistantPlan";

/**
 * CUSTOMERS AS A LIST (Sean, 2026-11-14: "DAX must have knowledge of those things, permission based") — until now DAX
 * could only find a customer by name. Held to the customers page's own rule: contacts.view_all or view_owned, and
 * only the customers getAccessibleContactIds allows (ANDed — never spread, so a filter can't replace it). Fleets
 * are the Automotive module's and need fleets.view/manage, as /fleets does. The workspace is named in every query.
 *
 * What is shown is what the customers page shows that person: name, company, area, tags, owner, open deals, phone,
 * email, birthday (day and month, as /birthdays). Never ID or VAT numbers, notes or research. Nothing is logged.
 */

type Args = z.infer<typeof customersArgs>;
type Output = { rows: { label: string; detail: string; href: string }[]; data: unknown[]; truncated: boolean };
const DAY = 86_400_000;
const note = (text: string): Output => ({ rows: [], data: [{ note: text }], truncated: false });
const fuzzy = (needle: string) => ({ contains: needle, mode: "insensitive" as const });
const day = (d: Date) => d.toISOString().slice(0, 10);

export async function customersLookup(user: PermissionUser, args: Args): Promise<Output> {
  if (!(await hasAnyPermission(user, "contacts.view_all", "contacts.view_owned"))) return note("You don't have access to customers.");
  const ids = await getAccessibleContactIds(user);
  if (ids !== null && ids.length === 0) return note("There are no customers you can open.");
  const tenantId = ownedWriteTenantId();
  // Fleets are Automotive's, behind their own permission — a filter or a column only for those who may open /fleets.
  const fleetsOpen = (await isModuleEnabled("automotive")) && (await hasAnyPermission(user, "fleets.view", "fleets.manage"));
  // Fleet MEMBERSHIP is fleet data too (review of #1103): without fleet access no fleet filter, no fleet kind — and a
  // fleet member is just a business, so "business" can't reveal who is on a fleet by leaving them out.
  if ((args.fleet || args.kind === "fleet") && !fleetsOpen) return note("You don't have access to fleets, so customers can't be listed by fleet.");
  const fleetIds = args.fleet
    ? (await prisma.fleet.findMany({ where: { tenantId, name: fuzzy(args.fleet) }, select: { id: true }, take: 50 })).map((f) => f.id)
    : null;
  if (fleetIds && fleetIds.length === 0) return note(`No fleet matches "${args.fleet}".`);

  // Birthdays from today, in day order (as /birthdays: 29 February is kept on 28 February in a common year).
  const days = args.birthdayWithinDays === undefined ? null : nextDays(args.birthdayWithinDays + 1);
  const createdAt = {
    ...(args.createdFrom ? { gte: new Date(`${args.createdFrom}T00:00:00+02:00`) } : {}),
    ...(args.createdTo ? { lt: new Date(new Date(`${args.createdTo}T00:00:00+02:00`).getTime() + DAY) } : {}),
  };
  const openLead = { status: "open", deletedAt: null };
  const where = {
    tenantId,
    deletedAt: null,
    AND: [
      ...(ids === null ? [] : [{ id: { in: ids } }]),
      ...(args.area ? [{ OR: [{ suburb: fuzzy(args.area) }, { city: fuzzy(args.area) }, { province: fuzzy(args.area) }, { address: fuzzy(args.area) }] }] : []),
      ...(args.tag ? [{ tags: { some: { name: fuzzy(args.tag) } } }] : []),
      ...(args.owner ? [{ owner: { name: fuzzy(args.owner) } }] : []),
      ...(args.kind === "individual" ? [{ isCompany: false }]
        : args.kind === "business" ? [fleetsOpen ? { isCompany: true, fleetId: null } : { isCompany: true }]
          : args.kind === "fleet" ? [{ fleetId: { not: null } }] : []),
      ...(fleetIds ? [{ fleetId: { in: fleetIds } }] : []),
      ...(days ? [{ OR: birthdayKeys(days).map((k) => ({ birthMonth: k.month, birthDay: k.day })) }] : []),
      ...(Object.keys(createdAt).length ? [{ createdAt }] : []),
      ...(args.openDeal === true ? [{ leads: { some: openLead } }] : args.openDeal === false ? [{ leads: { none: openLead } }] : []),
    ],
  };
  const take = args.limit ?? 10;
  const select = {
    id: true, firstName: true, lastName: true, company: true, isCompany: true, suburb: true, city: true,
    phone: true, whatsapp: true, email: true, birthDay: true, birthMonth: true, marketingOptOut: true, createdAt: true, fleetId: true,
    owner: { select: { name: true } },
    tags: { select: { name: true } },
    _count: { select: { leads: { where: openLead } } },
  } as const;
  const orderBy = args.sort === "name" ? [{ firstName: "asc" as const }, { id: "asc" as const }] : [{ createdAt: "desc" as const }, { id: "desc" as const }];
  const total = await prisma.contact.count({ where });
  // A BIRTHDAY WINDOW IS RANKED BY THE DAY, across every match (review of #1103: reading the newest 500 first could
  // leave out an older customer whose birthday is today). One query per day of the window, in day order, as
  // /birthdays does — at most 32 — until the list is full.
  let page: Prisma.ContactGetPayload<{ select: typeof select }>[] = [];
  if (days) {
    for (const d of days) {
      if (page.length >= take) break;
      page.push(...(await prisma.contact.findMany({
        where: { AND: [where, { OR: birthdayKeys([d]).map((k) => ({ birthMonth: k.month, birthDay: k.day })) }] },
        orderBy: [{ firstName: "asc" }, { id: "asc" }],
        take: take - page.length,
        select,
      })));
    }
  } else {
    page = await prisma.contact.findMany({ where, orderBy, take, select });
  }
  const fleetNames = fleetsOpen
    ? new Map((await prisma.fleet.findMany({
        where: { tenantId, id: { in: [...new Set(page.map((c) => c.fleetId).filter((id): id is string => !!id))] } },
        select: { id: true, name: true },
      })).map((f) => [f.id, f.name]))
    : new Map<string, string>();

  const shown = page.map((c) => ({
    customer: contactName(c),
    link: `/contacts/${c.id}`,
    kind: fleetsOpen && c.fleetId ? "fleet" : c.isCompany ? "business" : "individual",
    area: [c.suburb, c.city].filter(Boolean).join(", ") || null,
    ...(fleetsOpen && c.fleetId ? { fleet: fleetNames.get(c.fleetId) ?? null } : {}),
    tags: c.tags.map((t) => t.name),
    owner: c.owner?.name ?? "nobody",
    openDeals: c._count.leads,
    birthday: formatBirthday({ birthDay: c.birthDay, birthMonth: c.birthMonth, birthYear: null }),
    phone: c.whatsapp ?? c.phone ?? null,
    email: c.email ?? null,
    marketingOptOut: c.marketingOptOut,
    added: day(c.createdAt),
  }));
  return {
    truncated: total > shown.length,
    data: [{ total, listed: shown.length }, ...shown],
    rows: shown.map((c) => ({
      label: c.customer,
      detail: [c.area, c.birthday ? `birthday ${c.birthday}` : null, `${c.openDeals} open deal${c.openDeals === 1 ? "" : "s"}`, c.owner].filter(Boolean).join(" · "),
      href: c.link,
    })),
  };
}

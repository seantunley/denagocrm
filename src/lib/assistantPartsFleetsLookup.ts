import "server-only";
import type { z } from "zod";
import { prisma } from "./db";
import { ownedWriteTenantId } from "./tenantWrite";
import { getAccessibleContactIds, getAccessibleJobCardIds, getAccessibleLeadIds, hasAnyPermission, type PermissionUser } from "./permissions";
import { isModuleEnabled } from "./modules/enabled";
import { getRegionalSettings } from "./settings";
import { contactName, formatZAR } from "./format";
import { fleetTypeLabel } from "./fleetTypes";
import { CLOSED_JOB_STATUSES } from "./workshopRules";
import type { fleetsArgs, partsArgs } from "./crmAssistantPlan";

/**
 * PARTS STOCK and FLEET ACCOUNTS (Sean, 2026-11-14: "DAX must have knowledge of those things, permission based").
 * Each held to its page's own rule, and the workspace named in every query:
 *  - parts: the Automotive module and parts.view/parts.manage, as /parts. The sell price as the page lists it; the
 *    COST only to someone who may manage parts (a margin is not a parts viewer's to read). Notes are searched, never
 *    shown.
 *  - fleets: the Automotive module and fleets.view/fleets.manage, as /fleets. A fleet's open deals and job cards are
 *    counted and named only where this person may open them (getAccessibleLeadIds / getAccessibleJobCardIds, ANDed),
 *    its members only where they may open the customer — stricter than the fleet page, which pools them for any fleet
 *    viewer. Never registration, VAT or billing details.
 * Nothing is logged.
 */

type Output = { rows: { label: string; detail: string; href: string }[]; data: unknown[]; truncated: boolean };
const note = (text: string): Output => ({ rows: [], data: [{ note: text }], truncated: false });
const fuzzy = (needle: string) => ({ contains: needle, mode: "insensitive" as const });
const words = (s: string | undefined) => (s ?? "").split(/\s+/).filter((w) => w.length >= 2).slice(0, 6);

export async function partsLookup(user: PermissionUser, args: z.infer<typeof partsArgs>): Promise<Output> {
  if (!(await isModuleEnabled("automotive"))) return note("Parts are switched off for this workspace.");
  if (!(await hasAnyPermission(user, "parts.view", "parts.manage"))) return note("You don't have access to parts.");
  const showCost = await hasAnyPermission(user, "parts.manage");
  const tenantId = ownedWriteTenantId();
  // Every word must appear in the name, code, shelf or notes: "brake pads XL" finds "Brake pads — Rover XL".
  const parts = await prisma.part.findMany({
    where: {
      tenantId,
      active: true,
      deletedAt: null,
      AND: words(args.search).map((w) => ({ OR: [{ name: fuzzy(w) }, { sku: fuzzy(w) }, { location: fuzzy(w) }, { notes: fuzzy(w) }] })),
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: { id: true, name: true, sku: true, location: true, stockQty: true, reorderAt: true, priceCents: true, costCents: true },
  });
  // Low stock is a comparison of two columns, so it is read here — over this workspace's parts only.
  const matching = args.lowStock ? parts.filter((p) => p.reorderAt != null && p.stockQty <= p.reorderAt) : parts;
  const take = args.limit ?? 10;
  const page = matching.slice(0, take);
  const money = await getRegionalSettings();
  const shown = page.map((p) => ({
    part: p.name,
    code: p.sku,
    shelf: p.location,
    inStock: p.stockQty,
    reorderAt: p.reorderAt,
    low: p.reorderAt != null && p.stockQty <= p.reorderAt,
    sellPrice: formatZAR(p.priceCents, money),
    ...(showCost ? { cost: formatZAR(p.costCents, money) } : {}),
    link: "/parts",
  }));
  return {
    truncated: matching.length > shown.length,
    data: [{ total: matching.length, listed: shown.length, note: "Stock on hand as the Parts page shows it." }, ...shown],
    rows: shown.map((p) => ({ label: p.part, detail: [p.code, `${p.inStock} in stock${p.low ? " (low)" : ""}`, p.sellPrice].filter(Boolean).join(" · "), href: p.link })),
  };
}

export async function fleetsLookup(user: PermissionUser, args: z.infer<typeof fleetsArgs>): Promise<Output> {
  if (!(await isModuleEnabled("automotive"))) return note("Fleets are switched off for this workspace.");
  if (!(await hasAnyPermission(user, "fleets.view", "fleets.manage"))) return note("You don't have access to fleets.");
  const tenantId = ownedWriteTenantId();
  const fleetWhere = { tenantId, deletedAt: null, ...(args.fleet ? { name: fuzzy(args.fleet) } : {}) };
  const [total, fleets] = await Promise.all([
    prisma.fleet.count({ where: fleetWhere }),
    prisma.fleet.findMany({
      where: fleetWhere,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: args.limit ?? 10,
      select: { id: true, name: true, type: true, contactId: true, suburb: true, city: true, _count: { select: { vehicles: true } } },
    }),
  ]);
  if (!fleets.length) return note(args.fleet ? `No fleet matches "${args.fleet}".` : "There are no fleets yet.");

  const fleetIds = fleets.map((f) => f.id);
  const [contactIds, leadIds, jobIds] = await Promise.all([getAccessibleContactIds(user), getAccessibleLeadIds(user), getAccessibleJobCardIds(user)]);
  const only = (ids: string[] | null) => (ids === null ? [] : [{ id: { in: ids } }]);
  const [members, managers] = await Promise.all([
    prisma.contact.findMany({ where: { tenantId, deletedAt: null, fleetId: { in: fleetIds } }, select: { id: true, fleetId: true } }),
    prisma.contact.findMany({
      where: { tenantId, deletedAt: null, AND: [{ id: { in: fleets.map((f) => f.contactId).filter((id): id is string => !!id) } }, ...only(contactIds)] },
      select: { id: true, firstName: true, lastName: true, company: true },
    }),
  ]);
  const memberIds = members.map((m) => m.id);
  const fleetOf = new Map(members.map((m) => [m.id, m.fleetId]));
  // A fleet's open deals are its members' (the fleet page's rollup) — and only the ones this person may open.
  const [deals, jobs] = await Promise.all([
    leadIds !== null && leadIds.length === 0 ? [] : prisma.lead.findMany({
      where: { tenantId, deletedAt: null, status: "open", contactId: { in: memberIds }, AND: only(leadIds) },
      select: { id: true, title: true, name: true, contactId: true, stage: { select: { name: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    }),
    jobIds !== null && jobIds.length === 0 ? [] : prisma.jobCard.findMany({
      where: {
        tenantId, deletedAt: null, status: { notIn: CLOSED_JOB_STATUSES },
        AND: [{ OR: [{ vehicle: { fleetId: { in: fleetIds } } }, { contactId: { in: memberIds } }] }, ...only(jobIds)],
      },
      select: { id: true, number: true, status: true, contactId: true, vehicle: { select: { fleetId: true, model: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    }),
  ]);
  const visibleMembers = new Set(contactIds === null ? memberIds : memberIds.filter((id) => contactIds.includes(id)));
  const managerName = new Map(managers.map((m) => [m.id, contactName(m)]));

  const shown = fleets.map((f) => {
    const myDeals = deals.filter((d) => d.contactId && fleetOf.get(d.contactId) === f.id);
    const myJobs = jobs.filter((j) => j.vehicle?.fleetId === f.id || fleetOf.get(j.contactId) === f.id);
    return {
      fleet: f.name,
      link: `/fleets/${f.id}`,
      type: fleetTypeLabel(f.type),
      area: [f.suburb, f.city].filter(Boolean).join(", ") || null,
      manager: f.contactId ? managerName.get(f.contactId) ?? "(not one you can open)" : null,
      customers: members.filter((m) => m.fleetId === f.id && visibleMembers.has(m.id)).length,
      vehicles: f._count.vehicles,
      openDeals: myDeals.length,
      deals: myDeals.slice(0, 5).map((d) => ({ deal: `${d.name} — ${d.title}`, stage: d.stage.name, link: `/leads/${d.id}` })),
      openJobCards: myJobs.length,
      jobCards: myJobs.slice(0, 5).map((j) => ({ jobCard: `JC-${j.number}`, status: j.status, vehicle: j.vehicle?.model ?? null, link: `/jobcards/${j.id}` })),
    };
  });
  return {
    truncated: total > shown.length,
    data: [{ total, listed: shown.length, note: "Deals, job cards and customers are counted only where you may open them." }, ...shown],
    rows: shown.map((f) => ({ label: f.fleet, detail: [f.type, `${f.vehicles} vehicles`, `${f.openDeals} open deals`, `${f.openJobCards} open job cards`].filter(Boolean).join(" · "), href: f.link })),
  };
}

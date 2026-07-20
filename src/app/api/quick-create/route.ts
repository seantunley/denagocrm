import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { getAccessibleContactIds, getAccessibleVehicleIds, hasPermission } from "@/lib/permissions";
import { contactName } from "@/lib/format";
import { getSetting } from "@/lib/settings";
import { isModuleEnabled } from "@/lib/modules/enabled";

function inputDate(daysFromNow: number) {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  return date.toISOString().slice(0, 10);
}

/** Option lists for the Quick Actions create dialogs — one cached payload. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // This endpoint feeds the Quick-Create dialogs. It must not act as an
  // unguarded metadata directory for any signed-in user: gate the whole payload
  // behind actually being able to create SOMETHING, then gate each option list
  // by the specific create/assign permission that consumes it. Combined with the
  // pack gating (vehicles=automotive, products=commerce) and the accessible-id
  // scoping (a restricted salesperson never receives the whole org).
  const [
    automotiveOn,
    commerceOn,
    canCreateLead,
    canCreateContact,
    canCreateQuote,
    canManageVehicles,
    canScheduleActivity,
    contactIds,
    vehicleIds,
  ] = await Promise.all([
    isModuleEnabled("automotive"),
    isModuleEnabled("commerce"),
    hasPermission(user, "leads.create"),
    hasPermission(user, "contacts.create"),
    hasPermission(user, "quotes.create"),
    hasPermission(user, "vehicles.manage"),
    hasPermission(user, "activities.manage"),
    getAccessibleContactIds(user),
    getAccessibleVehicleIds(user),
  ]);

  // No create capability at all → nothing to hand out.
  if (!canCreateLead && !canCreateContact && !canCreateQuote && !canManageVehicles && !canScheduleActivity) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Which lists this caller may see, by the dialog that consumes each one.
  const needsContacts = canCreateLead || canCreateQuote || canManageVehicles || canScheduleActivity;
  const needsProducts = canCreateLead || canCreateQuote || canManageVehicles;
  const needsUsers = canCreateLead || canCreateContact || canScheduleActivity;
  const scoped = (ids: string[] | null) => (ids === null ? {} : { id: { in: ids } });

  const [products, stages, contacts, users, vehicles, validDaysRaw, quoteTerms] = await Promise.all([
    commerceOn && needsProducts
      ? prisma.product.findMany({
          where: { active: true },
          include: { colors: true },
          orderBy: { name: "asc" },
        })
      : Promise.resolve([]),
    canCreateLead
      ? prisma.pipelineStage.findMany({ orderBy: { order: "asc" }, select: { id: true, name: true } })
      : Promise.resolve([]),
    needsContacts
      ? prisma.contact.findMany({ where: scoped(contactIds), orderBy: { firstName: "asc" }, take: 500 })
      : Promise.resolve([]),
    needsUsers
      ? prisma.user.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } })
      : Promise.resolve([]),
    automotiveOn && canManageVehicles
      ? prisma.vehicle.findMany({
          where: scoped(vehicleIds),
          include: { contact: true },
          orderBy: { model: "asc" },
          take: 500,
        })
      : Promise.resolve([]),
    getSetting("QUOTE_VALID_DAYS"),
    getSetting("QUOTE_TERMS"),
  ]);

  const validDays = Number.parseInt(validDaysRaw ?? "7", 10);

  return NextResponse.json({
    products: products.map((p) => ({
      id: p.id,
      name: p.name,
      basePriceCents: p.basePriceCents,
      colors: p.colors.map((c) => c.name),
    })),
    stages,
    contacts: contacts.map((c) => ({ id: c.id, label: contactName(c) })),
    users,
    quoteDefaults: {
      validUntil: inputDate(Number.isFinite(validDays) ? validDays : 7),
      terms: quoteTerms || "Prices include VAT. Delivery arranged on acceptance. E&OE.",
    },
    vehicles: vehicles.map((v) => ({ id: v.id, label: `${v.model} — ${contactName(v.contact)}` })),
  });
}

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { getAccessibleContactIds, getAccessibleVehicleIds, hasPermission, hasAnyPermission } from "@/lib/permissions";
import { contactName } from "@/lib/format";
import { getSetting } from "@/lib/settings";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { listActingTenantStaff } from "@/lib/tenantActor";
import { fleetPicker } from "@/lib/fleetDirectory";
import { NO_FLEET_PICKER } from "@/lib/fleetTypes";

function inputDate(daysFromNow: number) {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  return date.toISOString().slice(0, 10);
}

/** Option lists for the Quick Actions create dialogs — one cached payload. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [
    automotiveOn,
    commerceOn,
    canCreateLead,
    canCreateContact,
    canCreateQuote,
    canManageVehicles,
    rawJobcards,
    canViewVehicles,
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
    hasPermission(user, "jobcards.manage"),
    hasAnyPermission(user, "vehicles.view_all", "vehicles.view_owned"),
    hasPermission(user, "activities.manage"),
    getAccessibleContactIds(user),
    getAccessibleVehicleIds(user),
  ]);

  const canManageJobcards = rawJobcards && canViewVehicles;
  if (
    !canCreateLead && !canCreateContact && !canCreateQuote &&
    !canManageVehicles && !canManageJobcards && !canScheduleActivity
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const needsContacts = canCreateLead || canCreateQuote || canManageVehicles || canScheduleActivity;
  const needsProducts = canCreateLead || canCreateQuote || canManageVehicles;
  const needsUsers = canCreateLead || canCreateContact || canScheduleActivity;
  const needsVehicles = canManageJobcards;
  const scoped = (ids: string[] | null) => (ids === null ? {} : { id: { in: ids } });

  const [products, stages, contacts, users, vehicles, picker, validDaysRaw, quoteTerms] = await Promise.all([
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
    needsUsers ? listActingTenantStaff() : Promise.resolve([]),
    automotiveOn && needsVehicles
      ? prisma.vehicle.findMany({
          where: scoped(vehicleIds),
          include: { contact: true },
          orderBy: { model: "asc" },
          take: 500,
        })
      : Promise.resolve([]),
    // Only the contact dialog offers a fleet, and the list is tenant-scoped
    // inside fleetPicker — never a bare fleet.findMany — and withheld entirely
    // from a user without the fleets permission.
    canCreateContact ? fleetPicker() : Promise.resolve(NO_FLEET_PICKER),
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
    fleetPicker: picker,
    quoteDefaults: {
      validUntil: inputDate(Number.isFinite(validDays) ? validDays : 7),
      terms: quoteTerms || "Prices include VAT. Delivery arranged on acceptance. E&OE.",
    },
    vehicles: vehicles.map((v) => ({ id: v.id, label: `${v.model} — ${contactName(v.contact)}` })),
  });
}

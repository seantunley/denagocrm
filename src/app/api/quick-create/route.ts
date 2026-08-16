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
import { withActingStaffScope } from "@/lib/actingScope";

function inputDate(daysFromNow: number) {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  return date.toISOString().slice(0, 10);
}

/** Option lists for the Quick Actions create dialogs — one cached payload. */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return withActingStaffScope(async () => {
  const kind = new URL(request.url).searchParams.get("kind");
  // Quote creation deliberately has its own dependency slice. The former shared
  // payload also loaded stages, staff, vehicles and fleet data; a failure in any
  // unrelated module made the quote editor unusable.
  if (kind === "quote") {
    const [commerceOn, canCreateQuote, contactIds] = await Promise.all([
      isModuleEnabled("commerce"),
      hasPermission(user, "quotes.create"),
      getAccessibleContactIds(user),
    ]);
    if (!commerceOn || !canCreateQuote) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const scoped = (ids: string[] | null) => (ids === null ? {} : { id: { in: ids } });
    const [products, contacts, validDaysRaw, quoteTerms] = await Promise.all([
      prisma.product.findMany({
        where: { active: true },
        include: { colors: true },
        orderBy: { name: "asc" },
      }),
      prisma.contact.findMany({
        where: scoped(contactIds),
        orderBy: { firstName: "asc" },
        take: 500,
      }),
      getSetting("QUOTE_VALID_DAYS"),
      getSetting("QUOTE_TERMS"),
    ]);
    const validDays = Number.parseInt(validDaysRaw ?? "7", 10);
    return NextResponse.json({
      products: products.map((product) => ({
        id: product.id,
        name: product.name,
        basePriceCents: product.basePriceCents,
        colors: product.colors.map((color) => color.name),
      })),
      contacts: contacts.map((contact) => ({ id: contact.id, label: contactName(contact) })),
      quoteDefaults: {
        validUntil: inputDate(Number.isFinite(validDays) ? validDays : 7),
        terms: quoteTerms || "Prices include VAT. Delivery arranged on acceptance. E&OE.",
      },
      stages: [],
      users: [],
      vehicles: [],
      fleetPicker: NO_FLEET_PICKER,
    });
  }

  const [
    automotiveOn,
    commerceOn,
    rawCanCreateLead,
    rawCanCreateContact,
    rawCanCreateQuote,
    rawCanManageVehicles,
    rawJobcards,
    canViewVehicles,
    rawCanScheduleActivity,
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
    !kind || ["lead", "vehicle", "calendar"].includes(kind)
      ? getAccessibleContactIds(user)
      : Promise.resolve([]),
    !kind || kind === "jobcard"
      ? getAccessibleVehicleIds(user)
      : Promise.resolve([]),
  ]);

  // A dialog asks only for its own dependencies. Besides reducing the payload,
  // this means a broken or disabled unrelated module cannot take every Quick
  // Create sheet down with it. No kind preserves the legacy full payload for
  // older callers during rollout.
  const canCreateLead = rawCanCreateLead && (!kind || kind === "lead");
  const canCreateContact = rawCanCreateContact && (!kind || kind === "contact");
  const canCreateQuote = rawCanCreateQuote && (!kind || kind === "quote");
  const canManageVehicles = rawCanManageVehicles && (!kind || kind === "vehicle");
  const canManageJobcards = rawJobcards && canViewVehicles && (!kind || kind === "jobcard");
  const canScheduleActivity = rawCanScheduleActivity && (!kind || kind === "calendar");
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
    !kind ? getSetting("QUOTE_VALID_DAYS") : Promise.resolve(null),
    !kind ? getSetting("QUOTE_TERMS") : Promise.resolve(null),
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
  });
}

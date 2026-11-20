import "server-only";
import { z } from "zod";
import { prisma } from "../../db";
import { formatZAR } from "../../format";
import { getRegionalSettings } from "../../settings";
import { isModuleEnabled } from "../../modules/enabled";
import { hasAnyPermission } from "../../permissions";
import { customerVehicles, workshopOverview } from "../../workshopContext";
import { vehicleArgs } from "../../crmAssistantPlan";
import { DAY, ToolOutput, User, fuzzy, refused } from "../lookupKit";
import { when } from "./schedule";
import { vehicleOwnershipLookup } from "./vehicleOwnership";

/** Demo vehicles and their bookings, stock units, or customers' own vehicles. */
export async function vehicles(user: User, raw: z.infer<typeof vehicleArgs>): Promise<ToolOutput> {
  const args = vehicleArgs.parse(raw);
  const take = args.limit ?? 15;
  const moneyFmt = await getRegionalSettings();
  if (args.kind === "stock") {
    if (!(await isModuleEnabled("commerce"))) return { truncated: false, rows: [], data: [{ note: "Stock isn't switched on for this workspace." }] };
    if (!(await hasAnyPermission(user, "stock.view", "stock.manage"))) return refused("stock");
    const units = await prisma.stockUnit.findMany({
      where: {
        deletedAt: null,
        ...(args.status ? { status: fuzzy(args.status) } : {}),
        ...(args.search
          ? { OR: [{ stockNumber: fuzzy(args.search) }, { serial: fuzzy(args.search) }, { label: fuzzy(args.search) }, { product: { name: fuzzy(args.search) } }] }
          : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: take + 1,
      select: {
        id: true, stockNumber: true, status: true, label: true, condition: true, color: true, location: true, salePriceCents: true,
        product: { select: { name: true } },
        reservedForLead: { select: { name: true } },
      },
    });
    const page = units.slice(0, take);
    return {
      truncated: units.length > take,
      data: page.map((u) => ({
        unit: u.stockNumber ?? u.id.slice(-6),
        link: `/stock/${u.id}`,
        product: u.product.name, status: u.status, label: u.label, condition: u.condition, colour: u.color, location: u.location,
        price: u.salePriceCents != null ? formatZAR(u.salePriceCents, moneyFmt) : null,
        reservedFor: u.reservedForLead?.name ?? null,
      })),
      rows: page.map((u) => ({ label: `${u.product.name}${u.stockNumber ? ` · ${u.stockNumber}` : ""}`, detail: `${u.status}${u.label ? ` · ${u.label}` : ""}`, href: `/stock/${u.id}` })),
    };
  }

  if (!(await isModuleEnabled("automotive"))) return { truncated: false, rows: [], data: [{ note: "Vehicles aren't switched on for this workspace." }] };

  if (args.kind === "demo") {
    if (!(await hasAnyPermission(user, "vehicles.view_all", "vehicles.view_owned", "activities.view", "activities.manage"))) return refused("demo vehicles");
    const demos = await prisma.demoVehicle.findMany({
      where: {
        deletedAt: null,
        ...(args.status ? { status: fuzzy(args.status) } : {}),
        ...(args.search ? { OR: [{ name: fuzzy(args.search) }, { regNumber: fuzzy(args.search) }, { branch: fuzzy(args.search) }] } : {}),
      },
      orderBy: { name: "asc" },
      take: take + 1,
      select: {
        name: true, status: true, branch: true, regNumber: true, odometerKm: true, batteryLevelPct: true,
        // Availability only — times and status, no customer: enough not to double-book it.
        bookings: {
          where: { deletedAt: null, status: { notIn: ["cancelled", "no_show", "completed"] }, expectedReturnAt: { gte: new Date() }, scheduledStart: { lt: new Date(Date.now() + 14 * DAY) } },
          orderBy: { scheduledStart: "asc" },
          select: { scheduledStart: true, expectedReturnAt: true, status: true },
        },
      },
    });
    const page = demos.slice(0, take);
    return {
      truncated: demos.length > take,
      data: page.map((d) => ({
        vehicle: d.name, status: d.status, branch: d.branch, reg: d.regNumber, odometerKm: d.odometerKm, batteryPct: d.batteryLevelPct,
        bookedNext14Days: d.bookings.map((b) => ({ from: when(b.scheduledStart), until: when(b.expectedReturnAt), status: b.status })),
      })),
      rows: [{ label: "Test drives", detail: `${page.length} demo vehicle${page.length === 1 ? "" : "s"}`, href: "/test-drives" }],
    };
  }

  // The workshop at a glance, and customers' vehicles with their workshop picture
  // (workshopContext: job cards and warranty claims behind their own grants).
  if (args.kind === "workshop") {
    const overview = await workshopOverview(user, { take: args.limit ?? 8, stuckDays: args.stuckDays ?? 5 });
    return overview ? { truncated: false, rows: overview.rows, data: [overview.data] } : refused("the workshop");
  }
  // Who owned it when (warranty-transfer-brief.md, PR 3) — lookups/vehicleOwnership.ts, behind the same grant.
  if (args.kind === "ownership") {
    return (await hasAnyPermission(user, "vehicles.view_all", "vehicles.view_owned"))
      ? vehicleOwnershipLookup(user, { search: args.search, limit: take })
      : refused("customer vehicles");
  }
  if (!(await hasAnyPermission(user, "vehicles.view_all", "vehicles.view_owned"))) return refused("customer vehicles");
  return customerVehicles(user, { search: args.search, limit: take });
}

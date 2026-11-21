import "server-only";
import { prisma } from "../../db";
import { contactName } from "../../format";
import { getAccessibleVehicleIds } from "../../permissions";
import { ownershipHistory } from "../../vehicleOwnership";
import { dateKey, fuzzy, type ToolOutput, type User } from "../lookupKit";

/**
 * DAX: who owned a customer's vehicle when (warranty-transfer-brief.md, PR 3) — each owner with dates and the reason it
 * changed hands, newest first. Only vehicles this person may open (the vehicles list's own rule); a search matches the
 * model, reg, VIN, the current owner or any earlier one. Staff-facing, like the vehicle page's Ownership panel.
 */
export async function vehicleOwnershipLookup(user: User, args: { search?: string; limit: number }): Promise<ToolOutput> {
  const accessible = await getAccessibleVehicleIds(user);
  const name = (s: string) => [{ firstName: fuzzy(s) }, { lastName: fuzzy(s) }, { company: fuzzy(s) }];
  const search = args.search?.trim();
  const vehicles = await prisma.vehicle.findMany({
    where: {
      deletedAt: null,
      ...(accessible ? { id: { in: accessible } } : {}),
      ...(search
        ? {
            OR: [
              { model: fuzzy(search) },
              { regNumber: fuzzy(search) },
              { vin: fuzzy(search) },
              { contact: { OR: name(search) } },
              { ownerships: { some: { contact: { OR: name(search) } } } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(args.limit, 10) + 1,
    select: { id: true, tenantId: true, model: true, regNumber: true, contact: { select: { firstName: true, lastName: true, company: true, isCompany: true } } },
  });
  const page = vehicles.slice(0, Math.min(args.limit, 10));
  const data = [];
  for (const v of page) {
    const owners = v.tenantId ? await ownershipHistory(v.tenantId, v.id) : [];
    data.push({
      vehicle: `${v.model}${v.regNumber ? ` (${v.regNumber})` : ""}`,
      link: `/vehicles/${v.id}`,
      vehicleId: v.id,
      currentOwner: contactName(v.contact),
      owners: owners.map((o) => ({
        owner: o.ownerName ?? "Previous owner (deleted)",
        contactId: o.contactId,
        from: o.reason === "registered" ? "first owner" : dateKey(o.ownedFrom),
        until: o.ownedUntil ? dateKey(o.ownedUntil) : "now",
        reason: o.reasonLabel,
        ...(o.reversedAt ? { undone: true } : {}),
        ...(o.odometerKm != null ? { odometerKm: o.odometerKm } : {}),
      })),
    });
  }
  return {
    truncated: vehicles.length > page.length,
    data,
    rows: page.map((v) => ({ label: `${v.model}${v.regNumber ? ` · ${v.regNumber}` : ""}`, detail: `Owned by ${contactName(v.contact)}`, href: `/vehicles/${v.id}` })),
  };
}

import { prisma } from "@/lib/db";
import { contactName } from "@/lib/format";
import { getAccessibleContactIds, hasPermission, type PermissionUser } from "@/lib/permissions";
import { ownershipHistory, undoBlockedBecause, warrantyTransferRule } from "@/lib/vehicleOwnership";
import { coverRemaining } from "@/lib/vehicleTransferRules";
import { isModuleEnabled } from "@/lib/modules/enabled";
import TransferVehicleDialog from "@/components/TransferVehicleDialog";
import VehicleOwnershipPanel from "@/components/VehicleOwnershipPanel";

const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * The vehicle page's Ownership panel and Transfer to new owner (warranty-transfer-brief.md, PR 1). Loads what both
 * need, so the page itself only places this.
 */
export default async function VehicleOwnershipSection({
  user,
  vehicle,
  openTransfer,
}: {
  user: PermissionUser;
  vehicle: {
    id: string;
    tenantId: string | null;
    model: string;
    contactId: string;
    contact: { firstName: string; lastName?: string | null; company?: string | null; isCompany?: boolean };
    purchaseDate: Date | null;
    warrantyMonths: number | null;
    /** Its warranty in parts (lib/warrantyParts.ts): the transfer dialog shows each part's cover. */
    warrantyParts?: unknown;
    warrantyStartsAt?: Date | null;
    documents: { id: string; fileName: string }[];
  };
  openTransfer: boolean;
}) {
  const tenantId = vehicle.tenantId;
  if (!tenantId) return null;
  const [entries, canTransfer, canDecideWarranty, canCreateContact, warrantyOn] = await Promise.all([
    ownershipHistory(tenantId, vehicle.id),
    hasPermission(user, "vehicles.transfer"),
    hasPermission(user, "warranty.manage"),
    hasPermission(user, "contacts.create"),
    // The Warranty module (its own switch): off, no warranty line on the transfer or the ownership history.
    isModuleEnabled("warranty"),
  ]);
  const current = entries.find((e) => !e.ownedUntil);
  let transferButton = null;
  let undoBlocked: string | null = null;
  if (canTransfer) {
    const accessible = await getAccessibleContactIds(user);
    const [contacts, rule, blocked] = await Promise.all([
      prisma.contact.findMany({
        where: { tenantId, deletedAt: null, id: accessible ? { in: accessible, not: vehicle.contactId } : { not: vehicle.contactId } },
        orderBy: { firstName: "asc" },
        take: 500,
      }),
      warrantyTransferRule(tenantId),
      undoBlockedBecause(tenantId, vehicle.id),
    ]);
    undoBlocked = blocked;
    transferButton = (
      <TransferVehicleDialog
        vehicleId={vehicle.id}
        model={vehicle.model}
        currentOwner={contactName(vehicle.contact)}
        currentOwnerId={vehicle.contactId}
        contacts={contacts.map((c) => ({ id: c.id, label: contactName(c) }))}
        canCreateContact={canCreateContact}
        earliest={day(current?.ownedFrom ?? new Date(0))}
        today={day(new Date())}
        cover={warrantyOn ? coverRemaining(vehicle) : null}
        rule={rule}
        documents={vehicle.documents.map((d) => ({ id: d.id, label: d.fileName }))}
        openOnArrival={openTransfer}
      />
    );
  }
  return (
    <VehicleOwnershipPanel
      vehicleId={vehicle.id}
      entries={entries}
      canTransfer={canTransfer}
      canDecideWarranty={canDecideWarranty}
      showWarranty={warrantyOn}
      undoBlocked={undoBlocked}
      transferButton={transferButton}
    />
  );
}

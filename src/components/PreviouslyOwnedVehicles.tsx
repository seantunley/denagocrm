import Link from "next/link";
import { formatDate } from "@/lib/format";
import { previouslyOwnedVehicles } from "@/lib/vehicleOwnership";

/**
 * "Previously owned" on a contact (warranty-transfer-brief.md, PR 1): vehicles they owned before a transfer. Staff see
 * the vehicle; its history stays with it and its current owner.
 */
export default async function PreviouslyOwnedVehicles({ tenantId, contactId }: { tenantId: string | null; contactId: string }) {
  if (!tenantId) return null;
  const vehicles = await previouslyOwnedVehicles(tenantId, contactId).catch(() => []);
  if (vehicles.length === 0) return null;
  return (
    <div className="mt-4 border-t border-border pt-3">
      <h3 className="mb-2 text-sm font-semibold">Previously owned</h3>
      <ul className="space-y-1.5">
        {vehicles.map((v) => (
          <li key={v.vehicleId} className="flex flex-wrap items-baseline gap-2 text-sm">
            <Link href={`/vehicles/${v.vehicleId}`} className="font-medium text-orange-400 hover:underline">
              {v.model}
              {v.color ? ` (${v.color})` : ""}
            </Link>
            {v.regNumber && <span className="text-xs text-slate-400">{v.regNumber}</span>}
            <span className="text-xs text-slate-400">
              {formatDate(v.ownedFrom)} – {formatDate(v.ownedUntil)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

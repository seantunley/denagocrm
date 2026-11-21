import ModalTrigger from "@/components/Modal";
import WarrantyTermsForm from "@/components/WarrantyTermsForm";
import { saveVehicleWarranty } from "@/app/actions/warrantyParts";
import { formatDate } from "@/lib/format";
import { johannesburgDateKey } from "@/lib/activityDay";
import { parseTerms, termLabel, type PartCover } from "@/lib/warrantyParts";

const STATUS: Record<PartCover["status"], { label: string; className: string }> = {
  active: { label: "Covered", className: "bg-emerald-500/15 text-emerald-300" },
  lifetime: { label: "Covered for life", className: "bg-emerald-500/15 text-emerald-300" },
  expired: { label: "Ended", className: "bg-slate-800 text-slate-400" },
};

/**
 * A vehicle's warranty, part by part (lib/warrantyParts.ts): what each part is covered for and until when. With
 * warranty.manage, "Edit warranty" changes this one vehicle's cover (a goodwill extension, a correction) — audited.
 */
export default function VehicleWarrantyParts({
  vehicle,
  cover,
  parts,
  canManage,
}: {
  vehicle: { id: string; warrantyParts: unknown; warrantyStartsAt: Date | null; purchaseDate: Date | null };
  cover: PartCover[];
  parts: readonly string[];
  canManage: boolean;
}) {
  const start = vehicle.warrantyStartsAt ?? vehicle.purchaseDate;
  return (
    <div className="mb-4 space-y-2">
      {cover.length === 0 ? (
        <p className="text-sm text-slate-400">No warranty recorded for this vehicle.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-400">
              <th className="font-medium pb-1">Part</th>
              <th className="font-medium pb-1">Cover</th>
              <th className="font-medium pb-1">Until</th>
              <th className="pb-1" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {cover.map((c) => (
              <tr key={c.part}>
                <td className="py-1.5">{c.part}</td>
                <td className="py-1.5">{termLabel(c.months)}</td>
                <td className="py-1.5 tabular-nums">{c.until ? formatDate(c.until) : "—"}</td>
                <td className="py-1.5 text-right"><span className={`badge ${STATUS[c.status].className}`}>{STATUS[c.status].label}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
        <span>{start ? `From ${formatDate(start)}` : ""}</span>
        {canManage && (
          <ModalTrigger label="Edit warranty" title="This vehicle's warranty" buttonClass="btn-secondary btn-sm">
            <p className="text-xs text-muted-foreground mb-3">
              Changes this vehicle only — not its model&apos;s terms. Recorded on the vehicle&apos;s history with what it was before.
            </p>
            <WarrantyTermsForm
              action={saveVehicleWarranty.bind(null, vehicle.id)}
              terms={parseTerms(vehicle.warrantyParts)}
              parts={parts}
              startsOn={start ? johannesburgDateKey(start) : ""}
            />
          </ModalTrigger>
        )}
      </div>
    </div>
  );
}

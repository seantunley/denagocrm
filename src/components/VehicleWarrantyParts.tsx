import ModalTrigger from "@/components/Modal";
import WarrantyTermsForm from "@/components/WarrantyTermsForm";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { issueVehicleCertificate, saveVehicleWarranty } from "@/app/actions/warrantyParts";
import { sendWarrantyCertificate } from "@/app/actions/warrantyCertificateSend";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import { formatDate } from "@/lib/format";
import { johannesburgDateKey } from "@/lib/activityDay";
import { parseTerms, termLabel, type PartCover } from "@/lib/warrantyParts";
import type { CertificateState } from "@/lib/warrantyCertificateState";

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
  certificate,
}: {
  vehicle: { id: string; warrantyParts: unknown; warrantyStartsAt: Date | null; purchaseDate: Date | null };
  cover: PartCover[];
  parts: readonly string[];
  canManage: boolean;
  /** The latest filed certificate (lib/warrantyCertificateStore.ts), if any. */
  certificate?: { id: string; createdAt: Date; state: CertificateState } | null;
}) {
  const start = vehicle.warrantyStartsAt ?? vehicle.purchaseDate;
  // After a transfer the filed certificate still names the previous owner: it is never sent as the new owner's.
  // Out of date (warranty edited) too: never sent until it's reissued (lib/warrantyCertificateState.ts).
  const previousOwners = certificate?.state === "previous_owner";
  const current = certificate?.state === "current";
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
      {(certificate || (canManage && cover.length > 0)) && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
          {certificate ? (
            <a href={`/api/files/${certificate.id}`} target="_blank" rel="noreferrer" className="text-orange-400 hover:underline">
              {previousOwners ? "Previous owner's certificate" : current ? "Warranty certificate" : "Out-of-date certificate"} · {formatDate(certificate.createdAt)}
            </a>
          ) : (
            <span>No certificate filed yet.</span>
          )}
          {canManage && cover.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {current && (
                // Only on this click, behind a Confirm: emailed to the owner with the PDF, through the consent check.
                <ConfirmActionDialog
                  trigger={<button type="button" className="btn-secondary btn-sm">Send to owner</button>}
                  title="Email the warranty certificate to the owner?"
                  description="The latest certificate is emailed to the vehicle's owner with the PDF attached, using your Warranty certificate email template. It's logged on the customer's timeline."
                  confirmLabel="Send"
                  onConfirm={sendWarrantyCertificate.bind(null, vehicle.id)}
                />
              )}
              <SaveForm action={issueVehicleCertificate.bind(null, vehicle.id)} success="Certificate filed">
                <SaveButton className="btn-secondary btn-sm" pendingLabel="Making the certificate…">
                  {previousOwners ? "Issue for the current owner" : certificate ? "Reissue certificate" : "Issue certificate"}
                </SaveButton>
              </SaveForm>
            </div>
          )}
        </div>
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

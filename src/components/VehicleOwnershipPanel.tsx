import Link from "next/link";
import type { ReactNode } from "react";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { decideVehicleWarrantyTransfer, sendVehicleWelcome, undoVehicleTransfer } from "@/app/actions/vehicleTransfer";
import { formatDate } from "@/lib/format";
import { OWNERSHIP_WARRANTY_LABELS } from "@/lib/vehicleTransferRules";
import type { OwnershipEntry } from "@/lib/vehicleOwnership";

/**
 * Ownership (warranty-transfer-brief.md, PR 1): every owner with dates and reason, newest first. Staff only — it names
 * every owner. The latest transfer can be undone until the new owner has activity; when it can't, the panel says why.
 */
export default function VehicleOwnershipPanel({
  vehicleId,
  entries,
  canTransfer,
  canDecideWarranty,
  showWarranty = true,
  undoBlocked,
  transferButton,
}: {
  vehicleId: string;
  entries: OwnershipEntry[];
  canTransfer: boolean;
  canDecideWarranty: boolean;
  /** The Warranty module on: the pending-approval note and each transfer's warranty badge. */
  showWarranty?: boolean;
  /** Null = the latest transfer may be undone; otherwise why not. */
  undoBlocked: string | null;
  transferButton: ReactNode;
}) {
  const current = entries.find((e) => !e.ownedUntil);
  const hasTransfer = entries.some((e) => e.reason !== "registered" && !e.reversedAt);
  return (
    <div className="card" id="ownership">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-semibold">Ownership</h2>
        {transferButton}
      </div>
      {showWarranty && current?.warranty === "pending" && (
        <div className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <p>The warranty transfer to the current owner is waiting for approval.</p>
          {canDecideWarranty && (
            <div className="mt-2 flex gap-2">
              <SaveForm action={decideVehicleWarrantyTransfer.bind(null, vehicleId)} success="Approved" resetOnSuccess={false}>
                <input type="hidden" name="decision" value="approve" />
                <SaveButton className="btn-primary btn-sm">Approve</SaveButton>
              </SaveForm>
              <SaveForm action={decideVehicleWarrantyTransfer.bind(null, vehicleId)} success="Declined" resetOnSuccess={false}>
                <input type="hidden" name="decision" value="decline" />
                <SaveButton className="btn-secondary btn-sm">Decline</SaveButton>
              </SaveForm>
            </div>
          )}
        </div>
      )}
      {entries.length === 0 ? (
        <p className="text-sm text-slate-400">No ownership record.</p>
      ) : (
        <ol className="space-y-3">
          {entries.map((e) => (
            <li key={e.id} className={`border-l-2 pl-3 ${e.reversedAt ? "border-slate-700 opacity-60" : e.ownedUntil ? "border-slate-500" : "border-emerald-400"}`}>
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-sm font-semibold">
                  {e.contactId && e.ownerName ? (
                    <Link href={`/contacts/${e.contactId}`} className="hover:underline">{e.ownerName}</Link>
                  ) : (
                    "Previous owner (deleted)"
                  )}
                </span>
                <span className="text-xs text-slate-400">
                  {formatDate(e.ownedFrom)} – {e.ownedUntil ? formatDate(e.ownedUntil) : "now"} · {e.reasonLabel}
                </span>
                {e.reversedAt && <span className="badge bg-slate-800 text-slate-400">Undone</span>}
                {showWarranty && e.reason !== "registered" && !e.reversedAt && e.warranty !== "carried" && (
                  <span className="badge bg-amber-500/15 text-amber-300">{OWNERSHIP_WARRANTY_LABELS[e.warranty]}</span>
                )}
              </div>
              <p className="text-xs text-slate-400">
                {[
                  e.odometerKm != null ? `${e.odometerKm.toLocaleString()} km at handover` : "",
                  e.transferredByName ? `Recorded by ${e.transferredByName}` : "",
                  e.reversedAt ? `Undone by ${e.reversedByName ?? "someone"} on ${formatDate(e.reversedAt)}` : "",
                ].filter(Boolean).join(" · ")}
              </p>
              {e.note && <p className="text-sm text-slate-400 whitespace-pre-wrap">{e.note}</p>}
              {e.reason !== "registered" && !e.reversedAt && (
                <div className="mt-1 flex flex-wrap items-center gap-3 text-xs">
                  <a href={`/vehicles/${vehicleId}/transfer-certificate?o=${e.id}`} target="_blank" rel="noreferrer" className="text-orange-400 hover:underline">
                    Transfer certificate
                  </a>
                  {/* Never automatic: a person presses Send, after reading what goes (warranty-transfer-brief.md). */}
                  {canTransfer && !e.ownedUntil && e.ownerName && (
                    <ConfirmActionDialog
                      trigger={<button type="button" className="text-orange-400 hover:underline">Send welcome</button>}
                      title={`Send ${e.ownerName} a welcome?`}
                      description={`Sends this workspace's "Welcome to a vehicle's new owner" message — by email, or by SMS if they can only be texted — with the vehicle${showWarranty ? " and its warranty" : ""}. Edit its wording in Settings → Email templates. It is logged on their timeline.`}
                      confirmLabel="Send"
                      onConfirm={sendVehicleWelcome.bind(null, vehicleId)}
                      success="Welcome sent"
                    />
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {canTransfer && hasTransfer && (
        <div className="mt-3 border-t border-border pt-3">
          {undoBlocked ? (
            <p className="text-xs text-muted-foreground">Undo isn&apos;t available: {undoBlocked}</p>
          ) : (
            <ConfirmActionDialog
              trigger={<button type="button" className="btn-secondary btn-sm">Undo the last transfer</button>}
              title="Undo the last transfer?"
              description="The vehicle goes back to its previous owner. The undone transfer stays in the history, marked as undone."
              confirmLabel="Undo transfer"
              onConfirm={undoVehicleTransfer.bind(null, vehicleId)}
              destructive
              success="Transfer undone"
            />
          )}
        </div>
      )}
    </div>
  );
}

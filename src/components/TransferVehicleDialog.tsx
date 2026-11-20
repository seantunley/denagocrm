"use client";

import { useState } from "react";
import ModalTrigger from "@/components/Modal";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import ContactPicker from "@/components/ContactPicker";
import { transferVehicle } from "@/app/actions/vehicleTransfer";
import { OWNERSHIP_REASON_LABELS, TRANSFER_REASONS, type WarrantyTransferRule } from "@/lib/vehicleTransferRules";

/**
 * Transfer to new owner (warranty-transfer-brief.md, PR 1): who takes it over, from when and why. The warranty and the
 * vehicle's whole history stay with the vehicle; the dialog says how much cover is left and what this workspace's
 * rule does with the warranty.
 */
export default function TransferVehicleDialog({
  vehicleId,
  model,
  currentOwner,
  contacts,
  canCreateContact,
  earliest,
  today,
  cover,
  rule,
  documents,
  openOnArrival,
}: {
  vehicleId: string;
  model: string;
  currentOwner: string;
  /** Contacts this person may open, the current owner left out. */
  contacts: { id: string; label: string }[];
  canCreateContact: boolean;
  /** The first allowed transfer date: the day the current ownership began ("YYYY-MM-DD"). */
  earliest: string;
  today: string;
  /** "14 months and 3 days of cover left (until …)". */
  cover: string;
  rule: WarrantyTransferRule;
  /** Documents on this vehicle that can be the proof of sale. */
  documents: { id: string; label: string }[];
  openOnArrival: boolean;
}) {
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [reason, setReason] = useState("");
  const ruleLine =
    reason === "correction"
      ? "A correction keeps the warranty exactly as it was."
      : rule === "yes"
        ? "The warranty transfers to the new owner."
        : rule === "no"
          ? "Under this workspace's rule the warranty does not transfer to the new owner."
          : "The warranty transfer will wait for approval by someone with warranty rights.";

  return (
    <ModalTrigger label="Transfer to new owner" title={`Transfer ${model} to a new owner`} buttonClass="btn-secondary" defaultOpen={openOnArrival}>
      <SaveForm action={transferVehicle.bind(null, vehicleId)} success="Transferred" className="space-y-4">
        <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
          <p>
            Currently owned by <strong>{currentOwner}</strong>. The vehicle&apos;s services, claims, job cards and documents stay
            with it; nothing is moved or copied.
          </p>
          <p className="mt-1 text-muted-foreground">Warranty: {cover}. {ruleLine}</p>
        </div>

        <fieldset className="space-y-2">
          <legend className="label">New owner</legend>
          {canCreateContact && (
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" name="ownerMode" value="existing" checked={mode === "existing"} onChange={() => setMode("existing")} className="accent-primary" />
                An existing contact
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="ownerMode" value="new" checked={mode === "new"} onChange={() => setMode("new")} className="accent-primary" />
                A new contact
              </label>
            </div>
          )}
          {mode === "existing" ? (
            <ContactPicker name="contactId" options={contacts} required />
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              <input name="firstName" required maxLength={80} placeholder="First name (or company)" className="input" />
              <input name="lastName" maxLength={80} placeholder="Last name" className="input" />
              <input name="phone" maxLength={40} placeholder="Phone" className="input" />
              <input name="email" type="email" maxLength={160} placeholder="Email" className="input" />
            </div>
          )}
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="label">Transfer date</span>
            <input type="date" name="date" required defaultValue={today} min={earliest} max={today} className="input" />
          </label>
          <label className="block space-y-1">
            <span className="label">Reason</span>
            <select name="reason" required value={reason} onChange={(e) => setReason(e.target.value)} className="input">
              <option value="" disabled>Choose…</option>
              {TRANSFER_REASONS.map((r) => (
                <option key={r} value={r}>{OWNERSHIP_REASON_LABELS[r]}</option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="label">Odometer at handover (km, optional)</span>
            <input type="number" name="odometerKm" min={0} step={1} className="input" />
          </label>
          {documents.length > 0 && (
            <label className="block space-y-1">
              <span className="label">Proof (optional)</span>
              <select name="proofDocumentId" defaultValue="" className="input">
                <option value="">None</option>
                {documents.map((d) => (
                  <option key={d.id} value={d.id}>{d.label}</option>
                ))}
              </select>
            </label>
          )}
        </div>
        <label className="block space-y-1">
          <span className="label">Note (optional)</span>
          <textarea name="note" rows={2} maxLength={1000} className="input" />
        </label>
        <SaveButton className="btn-primary" pendingLabel="Transferring…">Transfer</SaveButton>
      </SaveForm>
    </ModalTrigger>
  );
}

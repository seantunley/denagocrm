"use client";

import { SaveForm, SaveButton } from "@/components/SaveForm";
import { saveLeadNurture } from "@/app/actions/nurture";
import { NURTURE_REASONS } from "@/lib/leadNurture";

export default function NurtureForm({ leadId, users, ownerId, canAssign, initial, onSaved }: {
  leadId: string;
  users: { id: string; name: string }[];
  ownerId: string | null;
  canAssign: boolean;
  initial?: { reason: string | null; interest: string | null; trigger: string | null; reviewDate: string | null };
  onSaved?: () => void;
}) {
  return <SaveForm action={saveLeadNurture.bind(null, leadId)} onSaved={onSaved} resetOnSuccess={false} className="space-y-4">
    <p className="text-sm text-muted-foreground">Keep this opportunity for later. It leaves the active pipeline and forecast, while its contact and full history stay available.</p>
    <label className="block space-y-1.5"><span className="label">Reason</span>
      <select name="reason" className="input" defaultValue={initial?.reason ?? "product"} required>
        {Object.entries(NURTURE_REASONS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </label>
    <label className="block space-y-1.5"><span className="label">Product or interest</span>
      <input name="interest" className="input" defaultValue={initial?.interest ?? ""} required maxLength={120} placeholder="e.g. 4×4 / hunting vehicle" />
    </label>
    <label className="block space-y-1.5"><span className="label">When should we follow up?</span>
      <textarea name="trigger" className="input min-h-20" defaultValue={initial?.trigger ?? ""} required minLength={3} maxLength={500} placeholder="e.g. When 4×4 specifications and pricing become available" />
    </label>
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="block space-y-1.5"><span className="label">Review date</span>
        <input type="date" name="reviewDate" className="input" required defaultValue={initial?.reviewDate ?? ""} />
      </label>
      <label className="block space-y-1.5"><span className="label">Responsible salesperson</span>
        <select name="assignedToId" className="input" defaultValue={ownerId ?? ""} required>
          <option value="" disabled>Select salesperson</option>
          {users.filter((u) => canAssign || u.id === ownerId).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </label>
    </div>
    <p className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">A review task will be scheduled for the salesperson. Existing appointments and activities remain scheduled. Review those commitments separately if plans have changed.</p>
    <SaveButton className="btn-primary">{initial ? "Save nurture details" : "Move to nurture"}</SaveButton>
  </SaveForm>;
}

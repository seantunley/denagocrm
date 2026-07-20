"use client";

import { useActionState } from "react";
import {
  addPortalCaseMessage,
  createPortalCase,
  submitProfileChange,
  updatePortalPreferences,
  uploadPortalFile,
  type PortalActionState,
} from "@/app/actions/portalExpansion";

type Option = { id: string; label: string };

function Status({ state }: { state: PortalActionState }) {
  if (state.error) return <p className="text-sm text-red-400">{state.error}</p>;
  if (state.ok) return <p className="text-sm text-emerald-400">{state.ok}</p>;
  return null;
}

export function PortalProfileForm({ contact }: { contact: Record<string, string | null> }) {
  const [state, action, pending] = useActionState(submitProfileChange, {});
  return (
    <form action={action} className="space-y-4">
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="space-y-1"><span className="text-xs text-slate-400">First name</span><input name="firstName" className="input" defaultValue={contact.firstName ?? ""} required /></label>
        <label className="space-y-1"><span className="text-xs text-slate-400">Last name</span><input name="lastName" className="input" defaultValue={contact.lastName ?? ""} /></label>
        <label className="space-y-1"><span className="text-xs text-slate-400">Phone</span><input name="phone" className="input" defaultValue={contact.phone ?? ""} /></label>
        <label className="space-y-1"><span className="text-xs text-slate-400">WhatsApp</span><input name="whatsapp" className="input" defaultValue={contact.whatsapp ?? ""} /></label>
        <label className="space-y-1 sm:col-span-2"><span className="text-xs text-slate-400">Address</span><input name="address" className="input" defaultValue={contact.address ?? ""} /></label>
        <label className="space-y-1"><span className="text-xs text-slate-400">Suburb</span><input name="suburb" className="input" defaultValue={contact.suburb ?? ""} /></label>
        <label className="space-y-1"><span className="text-xs text-slate-400">City</span><input name="city" className="input" defaultValue={contact.city ?? ""} /></label>
        <label className="space-y-1"><span className="text-xs text-slate-400">Province</span><input name="province" className="input" defaultValue={contact.province ?? ""} /></label>
        <label className="space-y-1"><span className="text-xs text-slate-400">Postal code</span><input name="postalCode" className="input" defaultValue={contact.postalCode ?? ""} /></label>
      </div>
      <label className="space-y-1 block"><span className="text-xs text-slate-400">Note for our team</span><textarea name="note" className="input min-h-20" /></label>
      <Status state={state} />
      <button className="btn-primary" disabled={pending}>{pending ? "Submitting…" : "Request profile update"}</button>
    </form>
  );
}

export function PortalPreferenceForm({ defaults }: { defaults: { serviceReminders: boolean; portalNotifications: boolean; marketingEmail: boolean; smsServiceUpdates: boolean } }) {
  const [state, action, pending] = useActionState(updatePortalPreferences, {});
  return (
    <form action={action} className="space-y-3">
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="serviceReminders" defaultChecked={defaults.serviceReminders} /> Email service reminders</label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="smsServiceUpdates" defaultChecked={defaults.smsServiceUpdates} /> SMS service updates</label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="portalNotifications" defaultChecked={defaults.portalNotifications} /> Portal notifications</label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="marketingEmail" defaultChecked={defaults.marketingEmail} /> Marketing emails</label>
      <Status state={state} />
      <button className="btn-primary" disabled={pending}>{pending ? "Saving…" : "Save preferences"}</button>
    </form>
  );
}

export function PortalCaseForm({ vehicles, contacts, automotive = true }: { vehicles: Option[]; contacts: Option[]; automotive?: boolean }) {
  const [state, action, pending] = useActionState(createPortalCase, {});
  return (
    <form action={action} className="space-y-4">
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="space-y-1"><span className="text-xs text-slate-400">Request type</span><select name="type" className="input"><option value="support">General support</option>{automotive && <><option value="service">Service question</option><option value="warranty">Warranty request</option><option value="delivery">Delivery question</option></>}<option value="documents">Document request</option></select></label>
        <label className="space-y-1"><span className="text-xs text-slate-400">Priority</span><select name="priority" className="input"><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label>
        {contacts.length > 1 && <label className="space-y-1"><span className="text-xs text-slate-400">Customer/account contact</span><select name="contactId" className="input">{contacts.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>}
        {automotive && <label className="space-y-1"><span className="text-xs text-slate-400">Vehicle</span><select name="vehicleId" className="input"><option value="">Not vehicle-specific</option>{vehicles.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>}
      </div>
      <label className="space-y-1 block"><span className="text-xs text-slate-400">Subject</span><input name="subject" className="input" required /></label>
      <label className="space-y-1 block"><span className="text-xs text-slate-400">Details</span><textarea name="description" className="input min-h-32" required /></label>
      <Status state={state} />
      <button className="btn-primary" disabled={pending}>{pending ? "Submitting…" : "Submit request"}</button>
    </form>
  );
}

export function PortalCaseMessageForm({ caseId }: { caseId: string }) {
  const bound = addPortalCaseMessage.bind(null, caseId);
  const [state, action, pending] = useActionState(bound, {});
  return (
    <form action={action} className="space-y-3">
      <textarea name="body" className="input min-h-24" placeholder="Add a message…" required />
      <Status state={state} />
      <button className="btn-primary" disabled={pending}>{pending ? "Sending…" : "Send message"}</button>
    </form>
  );
}

export function PortalUploadForm({ vehicles, cases, automotive = true }: { vehicles: Option[]; cases: Option[]; automotive?: boolean }) {
  const [state, action, pending] = useActionState(uploadPortalFile, {});
  return (
    <form action={action} className="space-y-4">
      <input type="file" name="file" className="input" accept="application/pdf,image/jpeg,image/png,image/webp" required />
      <div className="grid sm:grid-cols-2 gap-3">
        {automotive && <label className="space-y-1"><span className="text-xs text-slate-400">Related vehicle</span><select name="vehicleId" className="input"><option value="">None</option>{vehicles.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>}
        <label className="space-y-1"><span className="text-xs text-slate-400">Related support case</span><select name="caseId" className="input"><option value="">None</option>{cases.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
      </div>
      <p className="text-xs text-slate-500">PDF, JPG, PNG or WebP. Maximum 10 MB.</p>
      <Status state={state} />
      <button className="btn-primary" disabled={pending}>{pending ? "Uploading…" : "Upload securely"}</button>
    </form>
  );
}

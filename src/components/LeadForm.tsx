"use client";

import { useState } from "react";
import DuplicateGuard from "@/components/DuplicateGuard";

export type LeadFormProduct = {
  id: string;
  name: string;
  basePriceCents: number;
  colors: string[];
};

type LeadDefaults = {
  title?: string;
  name?: string;
  email?: string | null;
  phone?: string | null;
  source?: string;
  productId?: string | null;
  color?: string | null;
  valueCents?: number;
  stageId?: string;
  contactId?: string | null;
  notes?: string | null;
  assignedToId?: string | null;
};

export default function LeadForm({
  action,
  products,
  stages,
  contacts,
  defaults = {},
  submitLabel,
  users = [],
}: {
  action: (formData: FormData) => Promise<void>;
  products: LeadFormProduct[];
  stages: { id: string; name: string }[];
  contacts: { id: string; label: string }[];
  defaults?: LeadDefaults;
  submitLabel: string;
  users?: { id: string; name: string }[];
}) {
  const [productId, setProductId] = useState(defaults.productId ?? "");
  const [value, setValue] = useState(
    defaults.valueCents ? String(defaults.valueCents / 100) : ""
  );
  const product = products.find((p) => p.id === productId);

  function onProductChange(id: string) {
    setProductId(id);
    const p = products.find((x) => x.id === id);
    if (p && p.basePriceCents > 0) setValue(String(p.basePriceCents / 100));
  }

  return (
    <form action={action} className="card space-y-4 max-w-2xl">
      <div className="grid md:grid-cols-2 gap-4">
        <div>
          <label className="label">Customer name *</label>
          <input name="name" className="input" required defaultValue={defaults.name ?? ""} />
        </div>
        <div>
          <label className="label">Source</label>
          <select name="source" className="input" defaultValue={defaults.source ?? "manual"}>
            <option value="manual">Manual</option>
            <option value="facebook">Facebook</option>
            <option value="instagram">Instagram</option>
            <option value="website">Website</option>
            <option value="referral">Referral</option>
            <option value="walk-in">Walk-in</option>
          </select>
        </div>
        <div>
          <label className="label">Referral code (if referred)</label>
          <input
            name="referralCode"
            className="input uppercase"
            placeholder="DGO-XXXX"
            maxLength={12}
          />
        </div>
        <div>
          <label className="label">Email</label>
          <input name="email" type="email" className="input" defaultValue={defaults.email ?? ""} />
        </div>
        <div>
          <label className="label">Phone</label>
          <input name="phone" className="input" defaultValue={defaults.phone ?? ""} />
        </div>
        <div>
          <label className="label">Product / model of interest</label>
          <select
            name="productId"
            className="input"
            value={productId}
            onChange={(e) => onProductChange(e.target.value)}
          >
            <option value="">—</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Colour</label>
          {product && product.colors.length > 0 ? (
            <select name="color" className="input" defaultValue={defaults.color ?? ""}>
              <option value="">—</option>
              {product.colors.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          ) : (
            <input
              name="color"
              className="input"
              placeholder="Colour of interest"
              defaultValue={defaults.color ?? ""}
            />
          )}
        </div>
        <div>
          <label className="label">Estimated value (R)</label>
          <input
            name="value"
            className="input"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="0.00"
          />
        </div>
        <div>
          <label className="label">Pipeline stage</label>
          <select name="stageId" className="input" defaultValue={defaults.stageId ?? stages[0]?.id}>
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        {users.length > 0 && (
          <div>
            <label className="label">Assigned to</label>
            <select name="assignedToId" className="input" defaultValue={defaults.assignedToId ?? ""}>
              <option value="">— unassigned —</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="md:col-span-2">
          <label className="label">Link to existing contact</label>
          <select name="contactId" className="input" defaultValue={defaults.contactId ?? ""}>
            <option value="">— none (new prospect) —</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div className="md:col-span-2">
          <label className="label">Deal title (optional — auto-generated)</label>
          <input name="title" className="input" defaultValue={defaults.title ?? ""} />
        </div>
      </div>
      <div>
        <label className="label">Notes</label>
        <textarea name="notes" className="input" rows={3} defaultValue={defaults.notes ?? ""} />
      </div>
      <DuplicateGuard />
      <button className="btn-primary">{submitLabel}</button>
    </form>
  );
}

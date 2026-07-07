"use client";

import { useState } from "react";

export type VehicleFormProduct = {
  id: string;
  name: string;
  colors: string[];
};

type VehicleDefaults = {
  contactId?: string;
  productId?: string | null;
  model?: string;
  vin?: string | null;
  regNumber?: string | null;
  color?: string | null;
  purchaseDate?: string | null; // yyyy-mm-dd
  warrantyMonths?: number | null;
  serviceIntervalKm?: number | null;
  serviceIntervalMonths?: number | null;
  notes?: string | null;
};

export default function VehicleForm({
  action,
  contacts,
  products,
  defaults = {},
  submitLabel,
  showInitialKm = false,
}: {
  action: (formData: FormData) => Promise<void>;
  contacts: { id: string; label: string }[];
  products: VehicleFormProduct[];
  defaults?: VehicleDefaults;
  submitLabel: string;
  showInitialKm?: boolean;
}) {
  const [productId, setProductId] = useState(defaults.productId ?? "");
  const [model, setModel] = useState(defaults.model ?? "");
  const product = products.find((p) => p.id === productId);

  function onProductChange(id: string) {
    setProductId(id);
    const p = products.find((x) => x.id === id);
    if (p) setModel(p.name);
  }

  return (
    <form action={action} className="card space-y-4 max-w-2xl">
      <div className="grid md:grid-cols-2 gap-4">
        <div>
          <label className="label">Customer *</label>
          <select
            name="contactId"
            className="input"
            required
            defaultValue={defaults.contactId ?? ""}
          >
            <option value="">Select customer…</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Product</label>
          <select
            name="productId"
            className="input"
            value={productId}
            onChange={(e) => onProductChange(e.target.value)}
          >
            <option value="">— custom / other —</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Model *</label>
          <input
            name="model"
            className="input"
            required
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
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
            <input name="color" className="input" defaultValue={defaults.color ?? ""} />
          )}
        </div>
        <div>
          <label className="label">VIN / Serial number</label>
          <input name="vin" className="input" defaultValue={defaults.vin ?? ""} />
        </div>
        <div>
          <label className="label">Registration number</label>
          <input name="regNumber" className="input" defaultValue={defaults.regNumber ?? ""} />
        </div>
        <div>
          <label className="label">Purchase date</label>
          <input
            type="date"
            name="purchaseDate"
            className="input"
            defaultValue={defaults.purchaseDate ?? ""}
          />
        </div>
        <div>
          <label className="label">Warranty (months)</label>
          <input
            name="warrantyMonths"
            type="number"
            className="input"
            defaultValue={defaults.warrantyMonths ?? ""}
          />
        </div>
        <div>
          <label className="label">Service interval (km)</label>
          <input
            name="serviceIntervalKm"
            type="number"
            className="input"
            defaultValue={defaults.serviceIntervalKm ?? 1000}
          />
        </div>
        <div>
          <label className="label">Service interval (months)</label>
          <input
            name="serviceIntervalMonths"
            type="number"
            className="input"
            defaultValue={defaults.serviceIntervalMonths ?? 6}
          />
        </div>
        {showInitialKm && (
          <div>
            <label className="label">Current mileage (km)</label>
            <input name="initialKm" type="number" className="input" placeholder="0" />
          </div>
        )}
        {showInitialKm && (
          <label className="flex items-center gap-2 text-sm text-slate-300 md:col-span-2 cursor-pointer">
            <input
              type="checkbox"
              name="newDelivery"
              className="h-4 w-4"
              defaultChecked={Boolean(defaults.productId)}
            />
            🎉 New delivery — email the customer a Google review request
          </label>
        )}
      </div>
      <div>
        <label className="label">Notes</label>
        <textarea name="notes" className="input" rows={3} defaultValue={defaults.notes ?? ""} />
      </div>
      <button className="btn-primary">{submitLabel}</button>
    </form>
  );
}

"use client";

import { useState } from "react";

type PartOption = { id: string; name: string; priceCents: number; stockQty: number };

/**
 * Add a parts/labour line. Picking a catalogue part fills the description +
 * price and links the line so stock is deducted on save. "Custom part" keeps
 * the old free-text behaviour.
 */
export default function JobCardItemForm({
  action,
  parts,
}: {
  action: (formData: FormData) => void;
  parts: PartOption[];
}) {
  const [kind, setKind] = useState("part");
  const [partId, setPartId] = useState("");
  const [description, setDescription] = useState("");
  const [unitPrice, setUnitPrice] = useState("");

  function pickPart(id: string) {
    setPartId(id);
    const p = parts.find((x) => x.id === id);
    if (p) {
      setDescription(p.name);
      setUnitPrice((p.priceCents / 100).toFixed(2));
    }
  }

  return (
    <form
      action={action}
      className="grid grid-cols-12 gap-2 items-end rounded-lg bg-slate-800/40 p-3 border border-slate-800"
    >
      <input type="hidden" name="partId" value={kind === "part" ? partId : ""} />
      <div className="col-span-6 md:col-span-2">
        <label className="label">Type</label>
        <select
          name="kind"
          className="input"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            if (e.target.value !== "part") setPartId("");
          }}
        >
          <option value="part">Part</option>
          <option value="labour">Labour</option>
        </select>
      </div>

      {kind === "part" && parts.length > 0 && (
        <div className="col-span-6 md:col-span-3">
          <label className="label">From catalogue</label>
          <select className="input" value={partId} onChange={(e) => pickPart(e.target.value)}>
            <option value="">Custom part…</option>
            {parts.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.stockQty} in stock)
              </option>
            ))}
          </select>
        </div>
      )}

      <div className={`col-span-12 ${kind === "part" && parts.length > 0 ? "md:col-span-3" : "md:col-span-5"}`}>
        <label className="label">Description</label>
        <input
          name="description"
          className="input"
          required
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="col-span-3 md:col-span-1">
        <label className="label">Qty</label>
        <input name="qty" className="input" defaultValue="1" inputMode="decimal" />
      </div>
      <div className="col-span-5 md:col-span-2">
        <label className="label">Unit (R)</label>
        <input
          name="unitPrice"
          className="input"
          inputMode="decimal"
          value={unitPrice}
          onChange={(e) => setUnitPrice(e.target.value)}
        />
      </div>
      <div className="col-span-4 md:col-span-1">
        <button className="btn-primary w-full">Add</button>
      </div>
    </form>
  );
}

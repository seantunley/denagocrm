"use client";

import { useMemo, useState } from "react";
import { CalendarDays, Coins, Plus, ShoppingCart, Trash2, Truck } from "lucide-react";
import {
  CaptureField,
  CaptureFooter,
  CaptureHero,
  CaptureSection,
  type CaptureFormVariant,
} from "@/components/capture-form";
import { cn } from "@/lib/utils";

export type PurchaseOrderProduct = {
  id: string;
  name: string;
  colors: string[];
};

type Line = {
  key: string;
  productId: string;
  color: string;
  qty: number;
  unitCost: string;
  notes: string;
};

function newLine(): Line {
  return {
    key: crypto.randomUUID(),
    productId: "",
    color: "",
    qty: 1,
    unitCost: "",
    notes: "",
  };
}

export default function PurchaseOrderBuilder({
  action,
  products,
  variant = "page",
}: {
  action: (formData: FormData) => Promise<void>;
  products: PurchaseOrderProduct[];
  variant?: CaptureFormVariant;
}) {
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const total = useMemo(
    () => lines.reduce((sum, line) => sum + Math.max(0, line.qty) * (Number.parseFloat(line.unitCost) || 0), 0),
    [lines],
  );
  const totalUnits = lines.reduce((sum, line) => sum + Math.max(0, line.qty), 0);

  function updateLine(key: string, patch: Partial<Line>) {
    setLines((current) => current.map((line) => line.key === key ? { ...line, ...patch } : line));
  }

  function removeLine(key: string) {
    setLines((current) => current.length === 1 ? current : current.filter((line) => line.key !== key));
  }

  return (
    <form
      action={action}
      className={cn("space-y-5", variant === "dialog" && "min-w-0", variant === "page" && "min-w-0")}
    >
      <input
        type="hidden"
        name="lines"
        value={JSON.stringify(lines.map(({ productId, color, qty, unitCost, notes }) => ({
          productId,
          color,
          qty,
          unitCost,
          notes,
        })))}
      />
      {(variant === "page" || variant === "dialog") && (
        <CaptureHero
          icon={ShoppingCart}
          eyebrow="Supplier purchasing"
          title="Build a purchase order"
          description="Order multiple Denago models and colours in one document. Physical stock units are created only when quantities are actually received."
          summary={[
            { label: "Lines", value: lines.length },
            { label: "Units", value: totalUnits },
            { label: "Base value", value: `R ${total.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` },
          ]}
        />
      )}

      <CaptureSection
        icon={Truck}
        title="Supplier & delivery"
        description="Record the supplier reference, expected arrival and any commercial context."
      >
        <CaptureField label="Supplier *">
          <input name="supplier" className="input" required defaultValue="Denago" />
        </CaptureField>
        <CaptureField label="Supplier PO / reference">
          <input name="reference" className="input" placeholder="e.g. DN-CPT-1042" />
        </CaptureField>
        <CaptureField label="Expected date">
          <div className="relative">
            <CalendarDays className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input name="expectedAt" type="date" className="input pl-10" />
          </div>
        </CaptureField>
        <CaptureField label="Currency">
          <select name="currency" className="input" defaultValue="ZAR">
            <option value="ZAR">ZAR — South African rand</option>
            <option value="USD">USD — US dollar</option>
            <option value="EUR">EUR — Euro</option>
            <option value="CNY">CNY — Chinese yuan</option>
          </select>
        </CaptureField>
        <CaptureField label="Order notes" wide>
          <textarea name="notes" className="input min-h-24 resize-y" placeholder="Shipping terms, requested build specification or supplier notes" />
        </CaptureField>
      </CaptureSection>

      <CaptureSection
        icon={ShoppingCart}
        title="Order lines"
        description="Each line tracks ordered and received quantities independently, enabling partial deliveries and backorders."
      >
        <div className="space-y-3 sm:col-span-2">
          {lines.map((line, index) => {
            const product = products.find((item) => item.id === line.productId);
            return (
              <div key={line.key} className="rounded-2xl border border-border bg-background/30 p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Line {index + 1}</p>
                    <p className="mt-0.5 text-sm font-medium text-foreground">{product?.name ?? "Select a model"}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeLine(line.key)}
                    disabled={lines.length === 1}
                    className="grid size-8 place-items-center rounded-lg border border-border text-muted-foreground transition-colors hover:border-red-400/30 hover:bg-red-400/10 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-30"
                    aria-label={`Remove line ${index + 1}`}
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
                <div className="grid gap-3 md:grid-cols-12">
                  <div className="md:col-span-4">
                    <label className="label">Model *</label>
                    <select
                      className="input"
                      required
                      value={line.productId}
                      onChange={(event) => updateLine(line.key, { productId: event.target.value, color: "" })}
                    >
                      <option value="" disabled>Select model…</option>
                      {products.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                    </select>
                  </div>
                  <div className="md:col-span-3">
                    <label className="label">Colour</label>
                    {product?.colors.length ? (
                      <select className="input" value={line.color} onChange={(event) => updateLine(line.key, { color: event.target.value })}>
                        <option value="">Not specified</option>
                        {product.colors.map((color) => <option key={color} value={color}>{color}</option>)}
                      </select>
                    ) : (
                      <input className="input" value={line.color} onChange={(event) => updateLine(line.key, { color: event.target.value })} placeholder="Optional" />
                    )}
                  </div>
                  <div className="md:col-span-2">
                    <label className="label">Quantity *</label>
                    <input type="number" min="1" max="500" className="input tabular-nums" value={line.qty} onChange={(event) => updateLine(line.key, { qty: Math.max(1, Number(event.target.value) || 1) })} />
                  </div>
                  <div className="md:col-span-3">
                    <label className="label">Unit cost (R)</label>
                    <input inputMode="decimal" className="input tabular-nums" value={line.unitCost} onChange={(event) => updateLine(line.key, { unitCost: event.target.value })} placeholder="0.00" />
                  </div>
                  <div className="md:col-span-12">
                    <label className="label">Line notes</label>
                    <input className="input" value={line.notes} onChange={(event) => updateLine(line.key, { notes: event.target.value })} placeholder="Build specification or line-specific instruction" />
                  </div>
                </div>
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => setLines((current) => [...current, newLine()])}
            className="btn-secondary w-full border-dashed"
          >
            <Plus className="size-4" /> Add another model or colour
          </button>
        </div>
      </CaptureSection>

      <CaptureSection
        icon={Coins}
        title="Expected landed costs"
        description="These order-level costs are retained for valuation and can be refined again on each goods receipt."
      >
        <CaptureField label="Freight (R)">
          <input name="freight" inputMode="decimal" className="input tabular-nums" placeholder="0.00" />
        </CaptureField>
        <CaptureField label="Duties / import charges (R)">
          <input name="duties" inputMode="decimal" className="input tabular-nums" placeholder="0.00" />
        </CaptureField>
        <CaptureField label="Other landed costs (R)">
          <input name="otherCosts" inputMode="decimal" className="input tabular-nums" placeholder="0.00" />
        </CaptureField>
        <div className="rounded-xl border border-primary/20 bg-primary/10 p-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-primary">Current order base value</p>
          <p className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-foreground">R {total.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
          <p className="mt-1 text-xs text-muted-foreground">Overheads are allocated proportionally to received units to create their landed cost.</p>
        </div>
      </CaptureSection>

      <CaptureFooter label="Create purchase order" requiredNote="At least one model line is required." kind="stock" variant={variant} />
    </form>
  );
}

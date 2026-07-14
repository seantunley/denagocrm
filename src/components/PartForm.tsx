"use client";

import { useMemo, useState } from "react";
import { BadgeDollarSign, Barcode, BellRing, Boxes, MapPin, Wrench } from "lucide-react";
import {
  CaptureField,
  CaptureFooter,
  CaptureHero,
  CaptureSection,
  type CaptureFormVariant,
} from "@/components/capture-form";
import { cn } from "@/lib/utils";

function numberValue(raw: string) {
  const value = Number(raw.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(value) ? value : 0;
}

export default function PartForm({
  action,
  variant = "compact",
}: {
  action: (formData: FormData) => Promise<void>;
  variant?: CaptureFormVariant;
}) {
  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [location, setLocation] = useState("");
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");
  const [stockQty, setStockQty] = useState("0");
  const [reorderAt, setReorderAt] = useState("");

  const margin = useMemo(() => {
    const sell = numberValue(price);
    if (sell <= 0) return "Margin pending";
    return `${Math.round(((sell - numberValue(cost)) / sell) * 100)}% gross margin`;
  }, [cost, price]);

  return (
    <form
      action={action}
      className={cn("space-y-4", variant === "compact" && "card max-w-3xl", variant === "page" && "min-w-0 space-y-5")}
    >
      {(variant === "page" || variant === "dialog") && (
        <CaptureHero
          icon={Wrench}
          eyebrow="Workshop inventory"
          title={name.trim() || "Create a parts catalogue item"}
          description="Define how the part is identified, valued, stored and replenished before workshop staff use it on job cards."
          summary={[
            { label: "SKU", value: sku.trim() || "Not assigned" },
            { label: "Opening stock", value: `${numberValue(stockQty)} units` },
            { label: "Pricing", value: margin },
          ]}
        />
      )}

      <CaptureSection
        icon={Barcode}
        title="Part identity"
        description="Use a clear workshop name and an internal code that is quick to recognise."
      >
        <CaptureField label="Part name *" wide>
          <input
            name="name"
            className="input"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Rover brake pad set"
          />
        </CaptureField>
        <CaptureField label="SKU / part code" hint="Use the supplier or internal stock code.">
          <input
            name="sku"
            className="input font-mono uppercase"
            autoCapitalize="characters"
            value={sku}
            onChange={(event) => setSku(event.target.value)}
            placeholder="DGO-BRK-001"
          />
        </CaptureField>
        <CaptureField label="Storage location" hint="A shelf, rack or bin reference keeps picking fast.">
          <div className="relative">
            <MapPin className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              name="location"
              className="input pl-10"
              value={location}
              onChange={(event) => setLocation(event.target.value)}
              placeholder="Shelf / bin"
            />
          </div>
        </CaptureField>
      </CaptureSection>

      <CaptureSection
        icon={BadgeDollarSign}
        title="Pricing"
        description="Capture both cost and selling price so workshop value and gross margin remain visible."
      >
        <CaptureField label="Cost price (R)">
          <input
            name="cost"
            className="input tabular-nums"
            inputMode="decimal"
            value={cost}
            onChange={(event) => setCost(event.target.value)}
            placeholder="0.00"
          />
        </CaptureField>
        <CaptureField label="Selling price (R)" hint={margin}>
          <input
            name="price"
            className="input tabular-nums"
            inputMode="decimal"
            value={price}
            onChange={(event) => setPrice(event.target.value)}
            placeholder="0.00"
          />
        </CaptureField>
      </CaptureSection>

      <CaptureSection
        icon={Boxes}
        title="Stock control"
        description="Set the opening balance and the level that should trigger a replenishment warning."
      >
        <CaptureField label="Opening stock">
          <input
            name="stockQty"
            type="number"
            min={0}
            step={1}
            className="input tabular-nums"
            value={stockQty}
            onChange={(event) => setStockQty(event.target.value)}
          />
        </CaptureField>
        <CaptureField label="Reorder alert at" hint="Leave blank when no low-stock alert is needed.">
          <div className="relative">
            <BellRing className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              name="reorderAt"
              type="number"
              min={0}
              step={1}
              className="input pl-10 tabular-nums"
              value={reorderAt}
              onChange={(event) => setReorderAt(event.target.value)}
              placeholder="Low-stock threshold"
            />
          </div>
        </CaptureField>
      </CaptureSection>

      <CaptureSection
        icon={Wrench}
        title="Workshop context"
        description="Leave fitment, supplier or compatibility detail for technicians and stock controllers."
      >
        <CaptureField label="Internal notes" wide>
          <textarea
            name="notes"
            className="input min-h-28 resize-y"
            rows={4}
            placeholder="Compatible models, supplier lead time, pack size or fitment notes"
          />
        </CaptureField>
      </CaptureSection>

      <CaptureFooter label="Add part" requiredNote="A part name is required." kind="part" variant={variant} />
    </form>
  );
}

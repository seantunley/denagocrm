"use client";

import { useState } from "react";
import {
  BadgeDollarSign,
  Boxes,
  CircleCheck,
  Fingerprint,
  Gauge,
  MapPin,
  PackagePlus,
  Palette,
  ShieldCheck,
} from "lucide-react";
import {
  CaptureField,
  CaptureFooter,
  CaptureHero,
  CaptureSection,
  type CaptureFormVariant,
} from "@/components/capture-form";
import { cn } from "@/lib/utils";

export type StockUnitProduct = {
  id: string;
  name: string;
  colors: string[];
};

export type StockUnitLocation = {
  id: string;
  name: string;
  type?: string;
  isDefault?: boolean;
};

export default function StockUnitForm({
  action,
  products,
  locations = [],
  variant = "compact",
}: {
  action: (formData: FormData) => Promise<void>;
  products: StockUnitProduct[];
  locations?: StockUnitLocation[];
  variant?: CaptureFormVariant;
}) {
  const [productId, setProductId] = useState("");
  const [color, setColor] = useState("");
  const [serial, setSerial] = useState("");
  const [cost, setCost] = useState("");
  const [landedCost, setLandedCost] = useState("");
  const product = products.find((item) => item.id === productId);
  const defaultLocation = locations.find((location) => location.isDefault)?.id ?? locations[0]?.id ?? "";

  function onProductChange(id: string) {
    setProductId(id);
    setColor("");
  }

  return (
    <form
      action={action}
      className={cn(
        "space-y-4",
        variant === "compact" && "card max-w-3xl",
        variant === "page" && "min-w-0 space-y-5",
      )}
    >
      {(variant === "page" || variant === "dialog") && (
        <CaptureHero
          icon={PackagePlus}
          eyebrow="Floor stock intake"
          title={product?.name ?? "Register a physical unit"}
          description="Capture a cart already on site. It enters the controlled stock ledger as available and can immediately be matched to demand."
          summary={[
            { label: "State", value: "Available" },
            { label: "Identity", value: serial.trim() || "Serial pending" },
            { label: "Landed cost", value: landedCost.trim() ? `R ${landedCost}` : cost.trim() ? `R ${cost}` : "Not recorded" },
          ]}
        />
      )}

      <CaptureSection
        icon={Gauge}
        title="Model & specification"
        description="Identify the catalogue model, physical colour and ownership condition."
      >
        <CaptureField label="Product / model *" wide>
          <select
            name="productId"
            className="input"
            required
            value={productId}
            onChange={(event) => onProductChange(event.target.value)}
          >
            <option value="" disabled>Select model…</option>
            {products.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </CaptureField>
        <CaptureField label="Colour" hint="Use a configured catalogue colour where possible." wide>
          {product && product.colors.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              <label className="cursor-pointer rounded-xl border border-border bg-background/40 px-3 py-2 text-xs text-muted-foreground transition-colors has-[:checked]:border-primary/45 has-[:checked]:bg-primary/10 has-[:checked]:text-foreground">
                <input type="radio" name="color" value="" checked={!color} onChange={() => setColor("")} className="sr-only" />
                Not recorded
              </label>
              {product.colors.map((option) => (
                <label key={option} className="cursor-pointer rounded-xl border border-border bg-background/40 px-3 py-2 text-xs text-muted-foreground transition-colors has-[:checked]:border-primary/45 has-[:checked]:bg-primary/10 has-[:checked]:text-foreground">
                  <input type="radio" name="color" value={option} checked={color === option} onChange={() => setColor(option)} className="sr-only" />
                  {option}
                </label>
              ))}
            </div>
          ) : (
            <div className="relative">
              <Palette className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input name="color" className="input pl-10" value={color} onChange={(event) => setColor(event.target.value)} placeholder="e.g. Matte black" />
            </div>
          )}
        </CaptureField>
        <CaptureField label="Condition">
          <select name="condition" className="input" defaultValue="new">
            <option value="new">New</option>
            <option value="demo">Demo</option>
            <option value="used">Used</option>
            <option value="consignment">Consignment</option>
            <option value="damaged">Damaged on intake</option>
          </select>
        </CaptureField>
        <CaptureField label="Physical location">
          <div className="relative">
            <MapPin className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <select name="locationId" className="input pl-10" defaultValue={defaultLocation}>
              {locations.length === 0 && <option value="">Main showroom</option>}
              {locations.map((location) => (
                <option key={location.id} value={location.id}>{location.name}</option>
              ))}
            </select>
          </div>
        </CaptureField>
      </CaptureSection>

      <CaptureSection
        icon={Fingerprint}
        title="Unit identity & valuation"
        description="Serial identity protects inventory integrity. Landed cost drives stock valuation and actual deal margin."
      >
        <CaptureField label="Serial / VIN" hint="Duplicate active serials are blocked automatically.">
          <input
            name="serial"
            className="input font-mono uppercase"
            autoCapitalize="characters"
            value={serial}
            onChange={(event) => setSerial(event.target.value.toUpperCase())}
            placeholder="Serial or VIN"
          />
        </CaptureField>
        <CaptureField label="Acquisition cost (R)">
          <div className="relative">
            <BadgeDollarSign className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input name="cost" className="input pl-10 tabular-nums" inputMode="decimal" value={cost} onChange={(event) => setCost(event.target.value)} placeholder="0.00" />
          </div>
        </CaptureField>
        <CaptureField label="Landed cost (R)" hint="Cost including freight, duties and receiving overhead.">
          <div className="relative">
            <BadgeDollarSign className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input name="landedCost" className="input pl-10 tabular-nums" inputMode="decimal" value={landedCost} onChange={(event) => setLandedCost(event.target.value)} placeholder={cost || "0.00"} />
          </div>
        </CaptureField>
        <div className="flex items-start gap-3 rounded-xl border border-sky-400/20 bg-sky-400/10 p-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-sky-400/10 text-sky-300">
            <ShieldCheck className="size-4" />
          </span>
          <div>
            <p className="text-sm font-medium text-sky-100">Controlled identity</p>
            <p className="mt-1 text-xs leading-5 text-sky-100/70">The system creates a unique internal stock number even when the manufacturer serial is still pending.</p>
          </div>
        </div>
      </CaptureSection>

      <CaptureSection
        icon={Boxes}
        title="Availability & context"
        description="The intake enters the live ledger and becomes visible to sales immediately."
      >
        <div className="flex items-start gap-3 rounded-xl border border-emerald-400/20 bg-emerald-400/10 p-3 sm:col-span-2">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-emerald-400/10 text-emerald-300">
            <CircleCheck className="size-4" />
          </span>
          <div>
            <p className="text-sm font-medium text-emerald-100">Available immediately</p>
            <p className="mt-1 text-xs leading-5 text-emerald-100/70">Arrival time and opening movement are recorded automatically. Reservations use atomic availability checks.</p>
          </div>
        </div>
        <CaptureField label="Internal notes" wide>
          <textarea name="notes" className="input min-h-28 resize-y" rows={4} placeholder="Condition, accessories, storage instructions or supplier context" />
        </CaptureField>
      </CaptureSection>

      <CaptureFooter label="Add to stock" requiredNote="A catalogue model is required." kind="stock" variant={variant} />
    </form>
  );
}

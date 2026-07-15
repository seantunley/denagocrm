"use client";

import { useMemo, useState } from "react";
import { BadgeDollarSign, FileText, PackageCheck, Palette, Shapes, Tags } from "lucide-react";
import { createProduct } from "@/app/actions/products";
import {
  CaptureField,
  CaptureFooter,
  CaptureHero,
  CaptureSection,
  type CaptureFormVariant,
} from "@/components/capture-form";
import { cn } from "@/lib/utils";

function priceSummary(value: string) {
  const parsed = Number(value.replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(parsed) || parsed <= 0) return "Price pending";
  return new Intl.NumberFormat("en-ZA", {
    style: "currency",
    currency: "ZAR",
    maximumFractionDigits: 0,
  }).format(parsed);
}

export default function ProductForm({ variant = "compact" }: { variant?: CaptureFormVariant }) {
  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [category, setCategory] = useState("");
  const [basePrice, setBasePrice] = useState("");
  const [colors, setColors] = useState("");
  const colorNames = useMemo(
    () => [...new Set(colors.split(",").map((color) => color.trim()).filter(Boolean))],
    [colors],
  );

  return (
    <form
      action={createProduct}
      className={cn(
        "space-y-4",
        variant === "compact" && "card max-w-3xl",
        variant === "page" && "min-w-0 space-y-5",
      )}
    >
      {(variant === "page" || variant === "dialog") && (
        <CaptureHero
          icon={Shapes}
          eyebrow="Catalogue setup"
          title={name.trim() || "Name the Denago model"}
          description="Create the reusable model record that powers leads, quotes, vehicle registrations and physical stock intake."
          summary={[
            { label: "Category", value: category.trim() || "Not classified" },
            { label: "Base price", value: priceSummary(basePrice) },
            { label: "Colours", value: colorNames.length ? `${colorNames.length} configured` : "Add options" },
          ]}
        />
      )}

      <CaptureSection
        icon={PackageCheck}
        title="Model identity"
        description="Use a recognisable catalogue name and identifiers that stay consistent across sales and workshop records."
      >
        <CaptureField label="Model name *" wide>
          <input
            name="name"
            className="input"
            required
            autoFocus={variant === "page"}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Denago EV Rover XL"
          />
        </CaptureField>
        <CaptureField label="SKU" hint="Optional internal catalogue or supplier reference.">
          <div className="relative">
            <Tags className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              name="sku"
              className="input pl-10 uppercase"
              value={sku}
              onChange={(event) => setSku(event.target.value)}
              placeholder="MODEL-SKU"
            />
          </div>
        </CaptureField>
        <CaptureField label="Category" hint="Groups related models throughout the catalogue.">
          <input
            name="category"
            className="input"
            list="product-category-suggestions"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            placeholder="e.g. Electric utility vehicle"
          />
          <datalist id="product-category-suggestions">
            <option value="Electric golf cart" />
            <option value="Electric utility vehicle" />
            <option value="Electric passenger vehicle" />
          </datalist>
        </CaptureField>
      </CaptureSection>

      <CaptureSection
        icon={BadgeDollarSign}
        title="Commercial defaults"
        description="Set the starting price used when this model is selected on a quote or lead."
      >
        <CaptureField label="Base price (R)" hint="This remains editable on individual quotes." wide>
          <div className="relative">
            <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm font-semibold text-muted-foreground">R</span>
            <input
              name="basePrice"
              className="input pl-10 tabular-nums"
              inputMode="decimal"
              value={basePrice}
              onChange={(event) => setBasePrice(event.target.value)}
              placeholder="0.00"
            />
          </div>
        </CaptureField>
      </CaptureSection>

      <CaptureSection
        icon={Palette}
        title="Customer choices"
        description="Configure the colour options staff can select during lead, quote, stock and vehicle capture."
      >
        <CaptureField label="Available colours" hint="Separate colour names with commas." wide>
          <input
            name="colors"
            className="input"
            value={colors}
            onChange={(event) => setColors(event.target.value)}
            placeholder="Graphite, Lava, White, Black, Blue"
          />
          {colorNames.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2" aria-label="Configured colours">
              {colorNames.map((color) => (
                <span key={color} className="rounded-full border border-border bg-muted/50 px-2.5 py-1 text-[11px] text-muted-foreground">
                  {color}
                </span>
              ))}
            </div>
          )}
        </CaptureField>
      </CaptureSection>

      <CaptureSection
        icon={FileText}
        title="Sales context"
        description="Add the short description staff should see when comparing or presenting this model."
      >
        <CaptureField label="Description" wide>
          <textarea
            name="description"
            className="input min-h-28 resize-y"
            rows={4}
            placeholder="Key positioning, capacity, use case or included equipment"
          />
        </CaptureField>
      </CaptureSection>

      <CaptureFooter
        label="Create product"
        requiredNote="A model name is required. Pricing and colours can be refined later."
        kind="product"
        variant={variant}
      />
    </form>
  );
}

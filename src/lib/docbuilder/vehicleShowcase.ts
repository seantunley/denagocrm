/**
 * The vehicle a quotation is FOR, as the showcase layout presents it.
 *
 * Pure (no server imports) so the renderer, the product form and the tests can
 * share it. The server half — reading the Product and embedding its photo — is
 * vehicleShowcaseLoad.ts.
 */
import { z } from "zod";
import { showcaseIconNames, type ShowcaseIcon } from "@/lib/doceditor/model";
import { isLineIncluded, type PricedLine } from "@/lib/pricing";

export const MAX_VEHICLE_SPECS = 4;

export type VehicleSpec = { icon: ShowcaseIcon; label: string; sub: string };

/** What the vehicleShowcase block renders. Carried on the merge context as `vars.showcase`. */
export type VehicleShowcaseData = {
  name: string;
  tagline: string;
  description: string;
  /** A `data:image/…` URL, or null — never a storage link (the PDF renderer cannot fetch those). */
  image: string | null;
  specs: VehicleSpec[];
};

const specSchema = z.object({
  icon: z.enum(showcaseIconNames).catch("premium"),
  label: z.string().trim(),
  sub: z.string().trim().catch(""),
});

/** Product.showcaseSpecs is free JSON: keep only well-formed, labelled items, at most four. */
export function parseVehicleSpecs(input: unknown): VehicleSpec[] {
  if (!Array.isArray(input)) return [];
  return input
    .flatMap((item) => {
      const parsed = specSchema.safeParse(item);
      return parsed.success && parsed.data.label ? [parsed.data] : [];
    })
    .slice(0, MAX_VEHICLE_SPECS);
}

type VehicleLine = PricedLine & { productId: string | null; kind: string; sortOrder: number };

/**
 * The quote's PRIMARY vehicle: the first charged line (by sortOrder) that is a
 * catalogue product. Accessories, trade-ins, service plans and an optional
 * add-on the customer did not take are never it. Null when no line names a
 * product — the caller then falls back to the lead's product of interest.
 */
export function primaryVehicleProductId(items: VehicleLine[]): string | null {
  const vehicle = items
    .filter((item) => isLineIncluded(item) && item.kind === "product" && item.productId)
    .sort((a, b) => a.sortOrder - b.sortOrder)[0];
  return vehicle?.productId ?? null;
}

export function showcaseFromProduct(
  product: { name: string; description: string | null; showcaseTagline: string | null; showcaseSpecs: unknown },
  image: string | null,
): VehicleShowcaseData {
  return {
    name: product.name.trim(),
    tagline: product.showcaseTagline?.trim() ?? "",
    description: product.description?.trim() ?? "",
    image: image && /^data:image\//i.test(image) ? image : null,
    specs: parseVehicleSpecs(product.showcaseSpecs),
  };
}

/** The showcase data off a render context's vars, or null when it is absent or malformed. */
export function readShowcase(vars: Record<string, unknown> | undefined): VehicleShowcaseData | null {
  const raw = vars?.showcase as Partial<VehicleShowcaseData> | undefined;
  if (!raw || typeof raw.name !== "string" || !raw.name) return null;
  return {
    name: raw.name,
    tagline: typeof raw.tagline === "string" ? raw.tagline : "",
    description: typeof raw.description === "string" ? raw.description : "",
    image: typeof raw.image === "string" && /^data:image\//i.test(raw.image) ? raw.image : null,
    specs: parseVehicleSpecs(raw.specs),
  };
}

/** "Denago EV Rover XL" under a "DENAGO EV" brand line reads "Rover XL" — the brand is already printed above it. */
export function modelName(name: string, brand: string): string {
  const b = brand.trim().toLowerCase();
  const n = name.trim();
  return b && n.toLowerCase().startsWith(`${b} `) ? n.slice(b.length).trim() : n;
}

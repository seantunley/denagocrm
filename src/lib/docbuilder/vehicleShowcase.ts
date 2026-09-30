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
import { detectProfileImageMime } from "@/lib/profile";

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
 * The quote's PRIMARY vehicle line: the first charged line (by sortOrder) that
 * is a catalogue product. Accessories, trade-ins, service plans and an optional
 * add-on the customer did not take are never it. Null when no line names a
 * product — the caller then falls back to the lead's product of interest.
 */
export function primaryVehicleLine<T extends VehicleLine>(items: T[]): T | null {
  return items
    .filter((item) => isLineIncluded(item) && item.kind === "product" && item.productId)
    .sort((a, b) => a.sortOrder - b.sortOrder)[0] ?? null;
}

export function primaryVehicleProductId(items: VehicleLine[]): string | null {
  return primaryVehicleLine(items)?.productId ?? null;
}

/** Colour names match trimmed and case-insensitively: a "lava " line finds the "Lava" photo. */
const colourKey = (colour: string) => colour.trim().toLowerCase();

/** Product.showcaseColourImages is free JSON: keep only { colour: non-empty ref } entries. */
export function parseColourImages(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => colourKey(entry[0]) !== "" && typeof entry[1] === "string" && entry[1] !== ""),
  );
}

/** The stored photo for `colour` (null when it has none of its own). */
export function colourImageRef(images: unknown, colour: string | null | undefined): string | null {
  const key = colour ? colourKey(colour) : "";
  if (!key) return null;
  return Object.entries(parseColourImages(images)).find(([name]) => colourKey(name) === key)?.[1] ?? null;
}

/** A product's colours, one per name as colour matching sees them (the first of any duplicates). */
export function uniqueColours<C extends { name: string }>(colours: C[]): C[] {
  const seen = new Set<string>();
  return colours.filter((c) => {
    const key = colourKey(c.name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type ShowcaseProductPhotos ={ showcaseImageRef: string | null; showcaseColourImages: unknown };

/** The photo a quote shows: the quoted colour's own photo, else the product's default photo, else none. */
export function showcaseImageRefFor(product: ShowcaseProductPhotos, colour: string | null | undefined): string | null {
  return colourImageRef(product.showcaseColourImages, colour) ?? product.showcaseImageRef ?? null;
}

/**
 * Which product the showcase shows and which of its photos. The vehicle line's
 * product in the line's colour; when no line resolves to a product, the lead's
 * product of interest in the lead's colour of interest.
 */
export function quoteVehiclePhoto<P extends ShowcaseProductPhotos>(
  line: { colorPreference: string | null } | null,
  lineProduct: P | null,
  lead: { product: P | null; color: string | null } | null | undefined,
): { product: P; imageRef: string | null } | null {
  if (lineProduct) return { product: lineProduct, imageRef: showcaseImageRefFor(lineProduct, line?.colorPreference) };
  if (lead?.product) return { product: lead.product, imageRef: showcaseImageRefFor(lead.product, lead.color) };
  return null;
}

/**
 * Upload rules for every showcase photo (default and per colour). They are
 * embedded into every quote PDF that shows them AND frozen, as bytes, into each
 * signature request's snapshot (freezeVehicleShowcase) — so this cap is also the
 * ceiling on what one showcase adds to a snapshot. A web-optimised cut-out is
 * typically 100–400 KB.
 */
export const SHOWCASE_IMAGE_MAX_BYTES = 1.5 * 1024 * 1024;

/** The checked type of an uploaded showcase photo, sniffed from its bytes (not the browser's say-so); throws when it is refused. */
export function checkShowcaseImage(bytes: Uint8Array): { mime: string; ext: string } {
  if (bytes.byteLength > SHOWCASE_IMAGE_MAX_BYTES) throw new Error("Product photos must be 1.5 MB or smaller — export a web-optimised PNG, JPG or WebP.");
  const mime = detectProfileImageMime(bytes);
  if (!mime) throw new Error("That file is not a PNG, JPG or WebP image.");
  return { mime, ext: mime === "image/jpeg" ? ".jpg" : mime === "image/png" ? ".png" : ".webp" };
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

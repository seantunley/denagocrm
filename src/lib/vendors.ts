/** Suppliers (Settings → Suppliers): what kind each is, and when two names are the same business. Pure. */

export const VENDOR_KINDS = [
  { value: "oem", label: "OEM / manufacturer" },
  { value: "transport", label: "Delivery / transport" },
  { value: "wrap", label: "Wrapping / accessories" },
  { value: "finance", label: "Finance" },
  { value: "other", label: "Other" },
] as const;

export type VendorKind = (typeof VENDOR_KINDS)[number]["value"];

export const vendorKind = (posted: unknown): VendorKind =>
  VENDOR_KINDS.find((kind) => kind.value === posted)?.value ?? "other";

export const vendorKindLabel = (kind: string): string =>
  VENDOR_KINDS.find((entry) => entry.value === kind)?.label ?? "Other";

// Company-form words that don't make a business different: "Wrap Studio (Pty) Ltd" is "Wrap Studio".
const LEGAL_SUFFIXES = new Set(["pty", "ltd", "limited", "proprietary", "cc", "inc", "llc", "plc", "npc", "soc"]);

/**
 * The supplier someone NAMED ("file this as Wrap Studio's invoice"), among the workspace's own. The same name
 * (normalised) wins; otherwise one supplier whose name contains the words said, or is contained by them ("Wrap" →
 * "Wrap Studio"). Two such, or none: no guess — the caller asks which.
 */
export function matchVendorByName<V extends { name: string }>(said: string, vendors: readonly V[]): { vendor: V } | { ambiguous: V[] } | { none: true } {
  const wanted = normaliseVendorName(said);
  if (!wanted) return { none: true };
  const exact = vendors.filter((vendor) => normaliseVendorName(vendor.name) === wanted);
  if (exact.length === 1) return { vendor: exact[0] };
  if (exact.length > 1) return { ambiguous: exact };
  const near = vendors.filter((vendor) => {
    const name = normaliseVendorName(vendor.name);
    return name.includes(wanted) || wanted.includes(name);
  });
  if (near.length === 1) return { vendor: near[0] };
  return near.length ? { ambiguous: near } : { none: true };
}

/** The name two suppliers are compared by: lower case, no punctuation, no company-form words. */
export function normaliseVendorName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((word) => word && !LEGAL_SUFFIXES.has(word))
    .join(" ");
}

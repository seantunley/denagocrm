/*
 * A workspace's regions — Province, State, County… (Sean, 2026-11-24: "Provinces: Yes, editable"). Offered on a
 * contact's address and in audience rules. Saved under Settings; a rand workspace that never saved a list keeps
 * South Africa's nine provinces, any other workspace starts with none (and the field stays hidden until it has some).
 */

export const REGIONS_KEY = "CONTACT_REGIONS";
export const REGION_LABEL_KEY = "CONTACT_REGION_LABEL";
export const REGIONS_MAX = 100;

export const SOUTH_AFRICAN_PROVINCES = [
  "Western Cape",
  "Eastern Cape",
  "Northern Cape",
  "Gauteng",
  "KwaZulu-Natal",
  "Free State",
  "North West",
  "Limpopo",
  "Mpumalanga",
];

const tidy = (value: unknown, max: number) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** One per line; blanks and repeats (any case) dropped, order kept. */
export function parseRegions(raw: string | null | undefined): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const line of String(raw ?? "").split("\n")) {
    const region = tidy(line, 80);
    if (!region || seen.has(region.toLowerCase())) continue;
    seen.add(region.toLowerCase());
    list.push(region);
    if (list.length === REGIONS_MAX) break;
  }
  return list;
}

/** No currency saved means rand (format.ts DEFAULT_REGIONAL). */
const isRand = (currency: string | null) => !currency || currency === "ZAR";

export function regionsOrDefault(saved: string | null, currency: string | null): string[] {
  const list = parseRegions(saved);
  if (list.length) return list;
  return isRand(currency) ? [...SOUTH_AFRICAN_PROVINCES] : [];
}

export function cleanRegionLabel(value: unknown): string {
  return tidy(value, 40);
}

export function regionLabel(saved: string | null, currency: string | null): string {
  return cleanRegionLabel(saved) || (isRand(currency) ? "Province" : "Region");
}

/**
 * Every region a saved audience rule names (field "province", one value or an "is any of" list), across groups and
 * exclusions. The audience builder keeps these choosable, so an emptied or shortened list never turns a saved rule
 * into a different field or drops its value (review of #1215).
 */
export function regionsInRules(tree: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const { field, value, rules, exclusions } = node as { field?: unknown; value?: unknown; rules?: unknown; exclusions?: unknown };
    if (field === "province") for (const v of Array.isArray(value) ? value : [value]) if (typeof v === "string" && v.trim()) found.push(v.trim());
    for (const child of [rules, exclusions]) if (Array.isArray(child)) child.forEach(walk);
  };
  walk(tree);
  return found;
}

/**
 * Whether any saved rule uses the region field at all — including "is empty" / "is not empty", which name no region.
 * The builder keeps the field for those too, so such a rule never opens as a different field (review of #1215).
 */
export function usesRegionRule(tree: unknown): boolean {
  if (!tree || typeof tree !== "object") return false;
  const { field, rules, exclusions } = tree as { field?: unknown; rules?: unknown; exclusions?: unknown };
  if (field === "province") return true;
  return [rules, exclusions].some((child) => Array.isArray(child) && child.some(usesRegionRule));
}

/** The list followed by any extra values (saved rules, a contact's own), deduplicated in any case. */
export function withKeptRegions(list: string[], kept: string[]): string[] {
  const seen = new Set(list.map((region) => region.toLowerCase()));
  const out = [...list];
  for (const region of kept) {
    if (seen.has(region.toLowerCase())) continue;
    seen.add(region.toLowerCase());
    out.push(region);
  }
  return out;
}

/** The choices for one contact: the list, plus the value it already has if the list dropped it — so a save never wipes it. */
export function regionChoices(list: string[], current: string | null | undefined): string[] {
  const value = tidy(current, 80);
  return value ? withKeptRegions(list, [value]) : list;
}

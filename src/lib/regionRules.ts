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

/** The choices for one contact: the list, plus the value it already has if the list dropped it — so a save never wipes it. */
export function regionChoices(list: string[], current: string | null | undefined): string[] {
  const value = tidy(current, 80);
  return value && !list.some((region) => region.toLowerCase() === value.toLowerCase()) ? [...list, value] : list;
}

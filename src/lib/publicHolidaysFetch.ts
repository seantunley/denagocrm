import "server-only";
import type { Holiday } from "./publicHolidays";

/**
 * Other countries' public holidays, from the Nager.Date public holiday calendar (date.nager.at — free, no key, about
 * 120 countries). Asked only when an owner picks or refreshes a country; only the country code and year are sent.
 * A holiday kept to some regions (England only, say) is labelled with them — the owner can skip it.
 */
const API = "https://date.nager.at/api/v3";
const TIMEOUT_MS = 8_000;

type NagerHoliday = { date: string; localName?: string; name: string; global?: boolean; counties?: string[] | null; types?: string[] };

export async function fetchCountryHolidays(country: string, year: number): Promise<Holiday[] | null> {
  if (!/^[A-Z]{2}$/.test(country)) return null;
  try {
    const res = await fetch(`${API}/PublicHolidays/${year}/${country}`, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
    if (!res.ok) return null;
    const list = (await res.json()) as NagerHoliday[];
    return list
      .filter((h) => /^\d{4}-\d{2}-\d{2}$/.test(h.date) && (h.types ?? ["Public"]).includes("Public"))
      .map((h) => {
        const regions = h.global === false && h.counties?.length ? ` (${h.counties.map((c) => c.split("-").pop()).join(", ")} only)` : "";
        return { date: h.date, name: `${h.name}${regions}`.slice(0, 80) };
      });
  } catch {
    return null;
  }
}

/** The countries the calendar covers, for the Settings dropdown — South Africa alone if it can't be reached. */
export async function holidayCountries(): Promise<{ code: string; name: string }[]> {
  try {
    const res = await fetch(`${API}/AvailableCountries`, { signal: AbortSignal.timeout(TIMEOUT_MS), next: { revalidate: 86_400 } });
    if (!res.ok) throw new Error(String(res.status));
    const list = (await res.json()) as { countryCode: string; name: string }[];
    const countries = list.filter((c) => /^[A-Z]{2}$/.test(c.countryCode)).map((c) => ({ code: c.countryCode, name: c.name }));
    return countries.some((c) => c.code === "ZA") ? countries : [{ code: "ZA", name: "South Africa" }, ...countries];
  } catch {
    return [{ code: "ZA", name: "South Africa" }];
  }
}

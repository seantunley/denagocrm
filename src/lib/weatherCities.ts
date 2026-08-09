/**
 * The cities shown in the dashboard clock/weather strip.
 *
 * They were a hardcoded constant — Cape Town and Moscow — in a client component,
 * which is fine for one business and wrong for a platform: a tenant in Durban
 * has no reason to watch Moscow, and no way to say so.
 *
 * Stored as a tenant setting, so the answer is per tenant and an owner controls
 * it. `getSetting`/`putSetting` already resolve the tenant from the request scope
 * and throw when there is none, so the isolation comes from the storage layer
 * rather than from anything this module has to remember to do.
 *
 * This module is pure: parsing, validation and the default. No Prisma, no
 * `server-only`, so the rules can actually be executed by a test rather than
 * matched as source text.
 */

export const WEATHER_CITIES_KEY = "DASHBOARD_WEATHER_CITIES";

export type WeatherCity = {
  /** What to call it. Not looked up anywhere — this is the label. */
  name: string;
  /** IANA zone, for the clock. */
  zone: string;
  lat: number;
  lon: number;
  /** ISO-3166 alpha-2, rendered as an emoji flag. Optional. */
  country?: string;
};

/**
 * Four. The strip is a single horizontal row beside the greeting, and it already
 * overflows on a laptop at three wide cards. A cap here is kinder than a strip
 * that quietly runs off the edge of the screen.
 */
export const MAX_WEATHER_CITIES = 4;

/**
 * What a tenant sees before anyone configures anything.
 *
 * Cape Town alone, not the old Cape Town + Moscow pair: Moscow was specific to
 * one business and would be a strange default to hand a new tenant. Existing
 * tenants keep whatever they save; nobody is migrated silently.
 */
export const DEFAULT_WEATHER_CITIES: readonly WeatherCity[] = [
  { name: "Cape Town", zone: "Africa/Johannesburg", lat: -33.925, lon: 18.48, country: "ZA" },
];

/** Is this a timezone this runtime actually knows? */
export function isValidZone(zone: string): boolean {
  if (!zone || zone.length > 60) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function cleanCity(raw: unknown): WeatherCity | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;

  const name = typeof entry.name === "string" ? entry.name.trim().slice(0, 40) : "";
  const zone = typeof entry.zone === "string" ? entry.zone.trim() : "";
  const lat = typeof entry.lat === "number" ? entry.lat : Number.NaN;
  const lon = typeof entry.lon === "number" ? entry.lon : Number.NaN;

  if (!name || !isValidZone(zone)) return null;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) return null;

  const country =
    typeof entry.country === "string" && /^[A-Za-z]{2}$/.test(entry.country.trim())
      ? entry.country.trim().toUpperCase()
      : undefined;

  return { name, zone, lat, lon, ...(country ? { country } : {}) };
}

/**
 * Read a stored value into cities.
 *
 * Total by construction. This feeds the strip beside the greeting on the home
 * screen — a stored value that is malformed, written by a newer release, or
 * edited by hand must degrade to the default rather than take the page down.
 * An empty list is a legitimate answer and means "show no cities"; only an
 * unreadable value falls back.
 */
export function parseWeatherCities(stored: string | null | undefined): WeatherCity[] {
  if (stored == null) return [...DEFAULT_WEATHER_CITIES];

  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  } catch {
    return [...DEFAULT_WEATHER_CITIES];
  }
  if (!Array.isArray(raw)) return [...DEFAULT_WEATHER_CITIES];

  const cities: WeatherCity[] = [];
  for (const entry of raw) {
    const city = cleanCity(entry);
    if (!city) continue;
    // Same place twice is a mistake, not an intention.
    if (cities.some((existing) => existing.name.toLowerCase() === city.name.toLowerCase())) continue;
    cities.push(city);
    if (cities.length >= MAX_WEATHER_CITIES) break;
  }
  // An explicitly empty list is respected; a list that was entirely unreadable
  // is not, because that is corruption rather than a choice.
  return raw.length > 0 && cities.length === 0 ? [...DEFAULT_WEATHER_CITIES] : cities;
}

/** The value to store. Runs the same cleaning, so a write cannot store what a read would reject. */
export function serialiseWeatherCities(cities: readonly WeatherCity[]): string {
  const cleaned: WeatherCity[] = [];
  for (const city of cities) {
    const ok = cleanCity(city);
    if (!ok) continue;
    if (cleaned.some((existing) => existing.name.toLowerCase() === ok.name.toLowerCase())) continue;
    cleaned.push(ok);
    if (cleaned.length >= MAX_WEATHER_CITIES) break;
  }
  return JSON.stringify(cleaned);
}

/**
 * The URL of a country's flag, served from our own origin.
 *
 * NOT an emoji. The first version used a regional-indicator pair, which needs no
 * assets and covers every country — and does not work: Windows ships no
 * country-flag font, so Chrome and Edge there draw the two letters "ZA" instead
 * of a flag. That is most of this app's users seeing what looks like a bug.
 *
 * Returns null for a missing or malformed code, so the caller renders nothing
 * rather than a broken image. See app/api/flag/[code] for why it is proxied.
 */
export function flagUrl(country: string | undefined): string | null {
  if (!country || !/^[A-Za-z]{2}$/.test(country)) return null;
  return `/api/flag/${country.toLowerCase()}`;
}

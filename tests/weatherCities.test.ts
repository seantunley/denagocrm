import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Source with CRLF normalised.
 *
 * This repo stores CRLF, so an anchor written with a bare newline silently
 * never matches - which reads as a missing guard rather than a broken test.
 */
const read = (rel: string) =>
  readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

import {
  DEFAULT_WEATHER_CITIES,
  MAX_WEATHER_CITIES,
  flagEmoji,
  isValidZone,
  parseWeatherCities,
  serialiseWeatherCities,
  type WeatherCity,
} from "../src/lib/weatherCities";

/**
 * The clock/weather strip's cities were a hardcoded constant — Cape Town and
 * Moscow — in a client component. Fine for one business, wrong for a platform:
 * a tenant in Durban has no reason to watch Moscow and no way to say so.
 *
 * They are now a tenant setting an owner controls. These cover the parsing and
 * validation; the tenant isolation itself comes from getSetting/putSetting,
 * which resolve the tenant from the request scope and throw when there is none.
 */

const cape: WeatherCity = {
  name: "Cape Town",
  zone: "Africa/Johannesburg",
  lat: -33.925,
  lon: 18.48,
  country: "ZA",
};

test("an unconfigured tenant gets the default, not an empty strip", () => {
  assert.deepEqual(parseWeatherCities(null), [...DEFAULT_WEATHER_CITIES]);
  assert.deepEqual(parseWeatherCities(undefined), [...DEFAULT_WEATHER_CITIES]);
});

test("the default is Cape Town alone, not the old hardcoded pair", () => {
  // Moscow was specific to one business and would be a strange thing to hand a
  // new tenant. Nobody's saved list is changed by this.
  assert.equal(DEFAULT_WEATHER_CITIES.length, 1);
  assert.equal(DEFAULT_WEATHER_CITIES[0].name, "Cape Town");
});

test("a stored list round-trips", () => {
  const cities: WeatherCity[] = [cape, { name: "Durban", zone: "Africa/Johannesburg", lat: -29.86, lon: 31.02 }];
  assert.deepEqual(parseWeatherCities(serialiseWeatherCities(cities)), cities);
});

test("an explicitly empty list means no cities, and is respected", () => {
  // Distinct from corruption: someone may genuinely want the strip bare.
  assert.deepEqual(parseWeatherCities("[]"), []);
});

test("an unreadable value degrades to the default rather than breaking the page", () => {
  // This renders beside the greeting on the home screen — the one page nobody
  // can route around.
  for (const stored of ["", "not json", "{}", '"a string"', "null", "42"]) {
    assert.deepEqual(parseWeatherCities(stored), [...DEFAULT_WEATHER_CITIES], `for ${stored}`);
  }
});

test("a list of entirely invalid entries falls back, rather than rendering nothing", () => {
  // Corruption, not a choice — unlike "[]" above.
  assert.deepEqual(parseWeatherCities('[{"name":""},{"zone":"Nowhere/Fake"}]'), [
    ...DEFAULT_WEATHER_CITIES,
  ]);
});

test("invalid entries are dropped from an otherwise good list", () => {
  const stored = JSON.stringify([
    cape,
    { name: "Nowhere", zone: "Not/AZone", lat: 0, lon: 0 },
    { name: "No coords", zone: "Europe/Paris" },
    { name: "Off the map", zone: "Europe/Paris", lat: 999, lon: 0 },
  ]);
  assert.deepEqual(parseWeatherCities(stored), [cape]);
});

test("a bad timezone is refused — the clock would be wrong, not just blank", () => {
  assert.ok(isValidZone("Africa/Johannesburg"));
  assert.ok(isValidZone("Europe/Moscow"));
  assert.ok(!isValidZone("Middle/Earth"));
  assert.ok(!isValidZone(""));
});

test("the same city twice is dropped", () => {
  const stored = JSON.stringify([cape, { ...cape, lat: 0 }]);
  assert.equal(parseWeatherCities(stored).length, 1);
});

test("the list is capped, on read and on write", () => {
  // The strip is one horizontal row and already overflows a laptop at three
  // wide cards; a cap is kinder than a strip running off the screen.
  const many = Array.from({ length: 10 }, (_, i) => ({ ...cape, name: `City ${i}` }));
  assert.equal(parseWeatherCities(JSON.stringify(many)).length, MAX_WEATHER_CITIES);
  assert.equal(JSON.parse(serialiseWeatherCities(many)).length, MAX_WEATHER_CITIES);
});

test("a write cannot store what a read would reject", () => {
  const stored = serialiseWeatherCities([
    cape,
    { name: "Nowhere", zone: "Not/AZone", lat: 0, lon: 0 },
  ] as WeatherCity[]);
  assert.deepEqual(JSON.parse(stored), [cape]);
});

test("names are trimmed and bounded", () => {
  const [city] = parseWeatherCities(
    JSON.stringify([{ ...cape, name: `   ${"x".repeat(80)}   ` }]),
  );
  assert.equal(city.name.length, 40);
  assert.doesNotMatch(city.name, /^\s|\s$/);
});

test("a country code becomes an emoji flag, and a bad one becomes nothing", () => {
  // Emoji rather than SVG assets: those exist for two countries and a tenant may
  // pick anywhere. A broken image is worse than no flag.
  assert.equal(flagEmoji("ZA"), "🇿🇦");
  assert.equal(flagEmoji("za"), "🇿🇦");
  assert.equal(flagEmoji("RU"), "🇷🇺");
  for (const bad of [undefined, "", "Z", "ZAF", "1A"]) assert.equal(flagEmoji(bad as string), "");
});

test("the strip reads its cities from the tenant setting, not a constant", () => {
  const component = read("src/components/ClockWeather.tsx");
  assert.doesNotMatch(component, /const CITIES = \[/, "the hardcoded list must be gone");
  assert.match(component, /cities/, "cities must arrive as data");
});

// ── the guards around the setting ───────────────────────────────────────────

test("only an owner can change the tenant's cities", () => {
  // The strip renders in the (app) layout, so this is what the whole workspace
  // sees. requireOwner decides WHO may write; putSetting decides WHICH tenant,
  // resolving it from the request scope and throwing when there is none — so a
  // direct POST cannot reach another tenant's list.
  const actions = read("src/app/actions/settings.ts");
  const fn = actions.slice(actions.indexOf("export async function saveWeatherCities"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
  assert.match(body, /requireOwner\(\)/);
  assert.match(body, /putSetting\(WEATHER_CITIES_KEY/);
  assert.doesNotMatch(body, /tenantId/, "the tenant must come from scope, never from the caller");
});

test("the write path runs the same validation as the read path", () => {
  // Otherwise a value could be stored that a later read rejects, and the strip
  // would silently fall back to the default with no explanation.
  const actions = read("src/app/actions/settings.ts");
  const fn = actions.slice(actions.indexOf("export async function saveWeatherCities"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
  assert.match(body, /serialiseWeatherCities/);
  assert.match(body, /parseWeatherCities/);
});

test("the city search is proxied server-side, not fetched from the browser", () => {
  // The geocoding host is NOT the one lib/csp.ts allows. Fetching it from the
  // browser would mean widening connect-src for a settings field.
  const route = read("src/app/api/weather-cities/search/route.ts");
  assert.match(route, /geocoding-api\.open-meteo\.com/);
  assert.match(route, /requireApiOwner\(\)/, "an on-demand outbound request needs a guard");
  assert.match(route, /isValidZone/, "a bad zone must be dropped before it can be saved");

  const csp = read("src/lib/csp.ts");
  assert.doesNotMatch(csp, /geocoding-api/, "the policy must not have been widened for this");
});

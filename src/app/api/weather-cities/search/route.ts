import { NextResponse } from "next/server";
import { apiAuthErrorResponse, requireApiOwner } from "@/lib/auth";
import { isValidZone } from "@/lib/weatherCities";

/**
 * City lookup for the clock/weather settings.
 *
 * WHY THIS IS A SERVER ROUTE AND NOT A FETCH FROM THE BROWSER.
 *
 * A city needs a name, a timezone and coordinates. Asking an owner to type
 * latitude, longitude and an IANA zone by hand is a good way to get a clock that
 * is confidently an hour wrong, so the list is searched rather than typed.
 *
 * Open-Meteo's geocoding endpoint lives on `geocoding-api.open-meteo.com`, a
 * DIFFERENT host from the `api.open-meteo.com` the CSP already allows. Calling
 * it from the browser would mean widening connect-src, and lib/csp.ts is
 * deliberate that hosts are listed only when something needs them. Proxying it
 * here keeps the policy as it is, and means the tenant's browser never talks to
 * a third party at all.
 *
 * It also lets the result be validated before it reaches the client: a zone this
 * runtime cannot resolve is dropped here rather than saved and discovered later
 * as a wrong time on somebody's dashboard.
 *
 * OWNER ONLY, matching the setting it feeds. There is nothing sensitive in a
 * list of cities, but an endpoint that makes outbound requests on demand should
 * not be open to every session.
 */

const UPSTREAM = "https://geocoding-api.open-meteo.com/v1/search";

export async function GET(request: Request) {
  try {
    await requireApiOwner();
  } catch (err) {
    return apiAuthErrorResponse(err) ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  // Two characters is where the upstream starts returning anything useful, and
  // it keeps a stray keystroke from becoming an outbound request.
  if (query.length < 2) return NextResponse.json({ cities: [] });

  let payload: unknown;
  try {
    const upstream = await fetch(
      `${UPSTREAM}?name=${encodeURIComponent(query.slice(0, 60))}&count=8&language=en&format=json`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!upstream.ok) return NextResponse.json({ cities: [] });
    payload = await upstream.json();
  } catch {
    // A search that cannot reach the internet returns nothing to choose from.
    // It must not fail the settings page, which has other things on it.
    return NextResponse.json({ cities: [] });
  }

  const results = Array.isArray((payload as { results?: unknown[] })?.results)
    ? ((payload as { results: Record<string, unknown>[] }).results ?? [])
    : [];

  const cities = results
    .map((row) => ({
      name: typeof row.name === "string" ? row.name.slice(0, 40) : "",
      zone: typeof row.timezone === "string" ? row.timezone : "",
      lat: typeof row.latitude === "number" ? row.latitude : Number.NaN,
      lon: typeof row.longitude === "number" ? row.longitude : Number.NaN,
      country: typeof row.country_code === "string" ? row.country_code.toUpperCase() : undefined,
      // Shown in the picker only, so "Durban" and "Durban, Ohio" are tellable
      // apart. Never stored.
      region: [row.admin1, row.country].filter((part) => typeof part === "string").join(", "),
    }))
    .filter(
      (city) =>
        city.name &&
        isValidZone(city.zone) &&
        Number.isFinite(city.lat) &&
        Number.isFinite(city.lon),
    );

  return NextResponse.json({ cities });
}

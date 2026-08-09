"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Search, X, Loader2 } from "lucide-react";
import { saveWeatherCities } from "@/app/actions/settings";
import { MAX_WEATHER_CITIES, flagEmoji, type WeatherCity } from "@/lib/weatherCities";

type Found = WeatherCity & { region?: string };

/**
 * Which cities appear in the clock/weather strip, for this tenant.
 *
 * SEARCHED, NOT TYPED. A city needs a timezone and coordinates, and asking
 * somebody to enter an IANA zone and a latitude by hand is how you end up with a
 * clock that is confidently an hour wrong. The search returns all three
 * together, already validated, from /api/weather-cities/search.
 *
 * Saving is EXPLICIT here, unlike the dashboard editor. A dashboard drag is an
 * unambiguous commit gesture on your own screen; this changes what everyone in
 * the tenant sees, and a mis-click that instantly republishes the strip to the
 * whole company is worth one button to avoid.
 */
export default function WeatherCitiesSettings({ initial }: { initial: WeatherCity[] }) {
  const [cities, setCities] = useState<WeatherCity[]>(initial);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Found[]>([]);
  const [searching, setSearching] = useState(false);
  const [saving, startSave] = useTransition();
  const requestId = useRef(0);

  const dirty = JSON.stringify(cities) !== JSON.stringify(initial);
  const full = cities.length >= MAX_WEATHER_CITIES;

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }
    // Debounced, and every response carries the id of the request that asked for
    // it — otherwise a slow early search can land after a fast later one and
    // replace the results with answers to a question already moved on from.
    const id = ++requestId.current;
    const timer = setTimeout(() => {
      setSearching(true);
      fetch(`/api/weather-cities/search?q=${encodeURIComponent(term)}`)
        .then((response) => response.json())
        .then((body) => {
          if (id !== requestId.current) return;
          setResults(Array.isArray(body?.cities) ? body.cities : []);
        })
        .catch(() => {
          if (id === requestId.current) setResults([]);
        })
        .finally(() => {
          if (id === requestId.current) setSearching(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  function add(found: Found) {
    if (full) return;
    // Same place twice is a mistake, not an intention — matched on coordinates
    // rather than name, so "Cape Town" from two sources still counts as one.
    if (cities.some((city) => city.lat === found.lat && city.lon === found.lon)) {
      toast.info(`${found.name} is already on the strip.`);
      return;
    }
    const { region: _region, ...city } = found;
    void _region;
    setCities([...cities, city]);
    setQuery("");
    setResults([]);
  }

  function save() {
    startSave(async () => {
      const result = await saveWeatherCities(cities).catch(() => ({
        error: "Could not save the cities.",
      }));
      if (result?.error) toast.error(result.error);
      else toast.success("Clock and weather updated.");
    });
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-semibold">Clock &amp; weather</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Shown at the top of every page, for everyone in this workspace. Up to {MAX_WEATHER_CITIES}.
        </p>
      </div>

      <ul className="space-y-1.5">
        {cities.map((city) => (
          <li
            key={`${city.lat},${city.lon}`}
            className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"
          >
            <span aria-hidden className="text-base leading-none">{flagEmoji(city.country)}</span>
            <span className="flex-1 text-sm text-foreground">{city.name}</span>
            <span className="text-xs text-muted-foreground">{city.zone}</span>
            <button
              type="button"
              onClick={() => setCities(cities.filter((entry) => entry !== city))}
              aria-label={`Remove ${city.name}`}
              className="flex size-6 items-center justify-center rounded text-muted-foreground hover:text-destructive"
            >
              <X className="size-3.5" />
            </button>
          </li>
        ))}
        {cities.length === 0 && (
          <li className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
            No cities — the strip will show the date only.
          </li>
        )}
      </ul>

      <div className="relative">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3">
          {searching ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            disabled={full}
            placeholder={full ? `That's ${MAX_WEATHER_CITIES} — remove one to add another` : "Search for a city…"}
            className="w-full bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          />
        </div>

        {results.length > 0 && (
          <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-border bg-card p-1 shadow-lg">
            {results.map((found) => (
              <li key={`${found.lat},${found.lon}`}>
                <button
                  type="button"
                  onClick={() => add(found)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <span aria-hidden>{flagEmoji(found.country)}</span>
                  <span className="text-foreground">{found.name}</span>
                  {found.region && (
                    <span className="truncate text-xs text-muted-foreground">{found.region}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <button
        type="button"
        onClick={save}
        disabled={!dirty || saving}
        className="btn btn-primary disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save cities"}
      </button>
    </div>
  );
}

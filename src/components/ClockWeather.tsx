"use client";

import { useEffect, useState } from "react";
import { flagUrl, type WeatherCity } from "@/lib/weatherCities";

// WMO weather codes → something a human wants to see
function describe(code: number): { icon: string; label: string } {
  if (code === 0) return { icon: "☀️", label: "Clear" };
  if (code <= 2) return { icon: "🌤", label: "Mostly sunny" };
  if (code === 3) return { icon: "☁️", label: "Overcast" };
  if (code <= 48) return { icon: "🌫", label: "Foggy" };
  if (code <= 57) return { icon: "🌦", label: "Drizzle" };
  if (code <= 67) return { icon: "🌧", label: "Rain" };
  if (code <= 77) return { icon: "🌨", label: "Snow?!" };
  if (code <= 82) return { icon: "🌧", label: "Showers" };
  if (code <= 86) return { icon: "🌨", label: "Snow showers" };
  return { icon: "⛈", label: "Thunderstorm" };
}

/*
 * The cities arrive as DATA, from a tenant setting an owner controls.
 *
 * They used to be a constant here - Cape Town and Moscow - which is fine for
 * one business and wrong for a platform: a tenant in Durban has no reason to
 * watch Moscow and had no way to say so. See lib/weatherCities.ts.
 */

type Weather = { temp: number; code: number };

const block =
  "flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 shadow-sm";

/** Compact desk strip: date, then a block per city (time + weather). */
export default function ClockWeather({ cities }: { cities: WeatherCity[] }) {
  const [now, setNow] = useState<Date | null>(null);
  const [weather, setWeather] = useState<(Weather | null)[]>(() => cities.map(() => null));

  useEffect(() => {
    setNow(new Date());
    // No seconds shown — a minute tick is enough and keeps the page calm
    const t = setInterval(() => setNow(new Date()), 30_000);

    const load = () =>
      Promise.all(
        cities.map((c) =>
          fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}&current=temperature_2m,weather_code`
          )
            .then((r) => r.json())
            .then((j) => ({
              temp: Math.round(j.current?.temperature_2m ?? 0),
              code: j.current?.weather_code ?? 0,
            }))
            .catch(() => null)
        )
      ).then(setWeather);
    load();
    const w = setInterval(load, 30 * 60 * 1000);
    return () => {
      clearInterval(t);
      clearInterval(w);
    };
    // Re-fetch when the tenant changes its cities, not only on mount. Keyed by
    // coordinates: the same places in a different order need no new request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cities.map((c) => `${c.lat},${c.lon}`).sort().join("|")]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Date */}
      <div className={block}>
        <span className="text-[13px] font-medium text-muted-foreground">
          {now
            ? now.toLocaleDateString("en-ZA", {
                weekday: "long",
                day: "numeric",
                month: "long",
                year: "numeric",
                timeZone: "Africa/Johannesburg",
              })
            : "…"}
        </span>
      </div>

      {/* One block per city */}
      {cities.map((c, i) => {
        const wx = weather[i] ? describe(weather[i]!.code) : null;
        return (
          <div key={c.name} className={block} title={c.name}>
            {/* An emoji flag, not an SVG asset: those exist for two countries
                and a tenant may pick anywhere. A missing code renders nothing,
                which beats a broken image. */}
            {flagUrl(c.country) && (
              // A real SVG, served from our own origin. An emoji flag renders as
              // the two letters on Windows, which is where most of these users are.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={flagUrl(c.country)!}
                alt=""
                width={18}
                height={13}
                loading="lazy"
                className="h-3 w-auto rounded-[2px]"
              />
            )}
            <span className="text-xs text-muted-foreground">{c.name}</span>
            <span className="text-[15px] font-semibold tabular-nums text-foreground">
              {now
                ? now.toLocaleTimeString("en-ZA", {
                    hour: "2-digit",
                    minute: "2-digit",
                    timeZone: c.zone,
                  })
                : "…"}
            </span>
            {wx && weather[i] && (
              <span className="flex items-center gap-1 border-l border-border pl-2 text-xs text-muted-foreground">
                <span className="text-sm leading-none">{wx.icon}</span>
                <span className="font-medium text-foreground">{weather[i]!.temp}°</span>
                {wx.label}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

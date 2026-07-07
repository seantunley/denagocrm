"use client";

import { useEffect, useState } from "react";

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

type Weather = { temp: number; code: number; wind: number };

/** Slim live clock + Cape Town weather strip (Open-Meteo, no key needed). */
export default function ClockWeather() {
  const [now, setNow] = useState<Date | null>(null);
  const [weather, setWeather] = useState<Weather | null>(null);

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);

    const load = () =>
      fetch(
        "https://api.open-meteo.com/v1/forecast?latitude=-33.925&longitude=18.48&current=temperature_2m,weather_code,wind_speed_10m&timezone=Africa%2FJohannesburg"
      )
        .then((r) => r.json())
        .then((j) =>
          setWeather({
            temp: Math.round(j.current?.temperature_2m ?? 0),
            code: j.current?.weather_code ?? 0,
            wind: Math.round(j.current?.wind_speed_10m ?? 0),
          })
        )
        .catch(() => {});
    load();
    const w = setInterval(load, 30 * 60 * 1000);
    return () => {
      clearInterval(t);
      clearInterval(w);
    };
  }, []);

  const zone = "Africa/Johannesburg";
  const wx = weather ? describe(weather.code) : null;

  return (
    <div className="card px-4 py-2.5 flex items-center justify-between gap-4 flex-wrap">
      <p className="text-sm text-slate-300">
        {now ? (
          <>
            <span className="text-slate-400">
              {now.toLocaleDateString("en-ZA", {
                weekday: "long",
                day: "numeric",
                month: "long",
                timeZone: zone,
              })}
            </span>
            <span className="font-bold text-lg text-white ml-3 tabular-nums">
              {now.toLocaleTimeString("en-ZA", {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                timeZone: zone,
              })}
            </span>
          </>
        ) : (
          "…"
        )}
      </p>
      {wx && weather && (
        <p className="text-sm text-slate-300">
          <span className="text-lg mr-1.5">{wx.icon}</span>
          <span className="font-bold text-white">{weather.temp}°C</span>
          <span className="text-slate-400 ml-2">
            {wx.label} · wind {weather.wind} km/h · Cape Town
          </span>
        </p>
      )}
    </div>
  );
}

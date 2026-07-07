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

const CITIES = [
  { flag: "/branding/flag-za.svg", name: "Cape Town", zone: "Africa/Johannesburg", lat: -33.925, lon: 18.48 },
  { flag: "/branding/flag-ru.svg", name: "Moscow", zone: "Europe/Moscow", lat: 55.751, lon: 37.618 },
];

type Weather = { temp: number; code: number };

/** Slim live clock + weather strip for Cape Town and Moscow (Open-Meteo, no key needed). */
export default function ClockWeather() {
  const [now, setNow] = useState<Date | null>(null);
  const [weather, setWeather] = useState<(Weather | null)[]>([null, null]);

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);

    const load = () =>
      Promise.all(
        CITIES.map((c) =>
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
  }, []);

  return (
    <div className="card px-4 py-2.5 flex items-center gap-x-6 gap-y-1 flex-wrap">
      <p className="text-sm text-slate-400">
        {now
          ? now.toLocaleDateString("en-ZA", {
              weekday: "long",
              day: "numeric",
              month: "long",
              timeZone: "Africa/Johannesburg",
            })
          : "…"}
      </p>
      {CITIES.map((c, i) => {
        const wx = weather[i] ? describe(weather[i]!.code) : null;
        return (
          <p key={c.name} className="text-sm text-slate-300 flex items-center" title={c.name}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={c.flag} alt="" className="h-3.5 w-auto rounded-[2px] mr-1.5" />
            <span className="text-slate-400 mr-2">{c.name}</span>
            <span className="font-bold text-lg text-white tabular-nums">
              {now
                ? now.toLocaleTimeString("en-ZA", {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                    timeZone: c.zone,
                  })
                : "…"}
            </span>
            {wx && weather[i] && (
              <>
                <span className="text-base ml-2.5 mr-1">{wx.icon}</span>
                <span className="font-semibold text-white">{weather[i]!.temp}°C</span>
                <span className="text-slate-400 ml-1.5">{wx.label}</span>
              </>
            )}
          </p>
        );
      })}
    </div>
  );
}

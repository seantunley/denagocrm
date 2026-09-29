"use client";

import { useEffect, useState } from "react";
import ModalPortal from "@/components/ui/modal-portal";

function wmo(code: number): { icon: string; label: string } {
  if (code === 0) return { icon: "☀️", label: "Clear" };
  if (code <= 2) return { icon: "🌤", label: "Mostly sunny" };
  if (code === 3) return { icon: "☁️", label: "Overcast" };
  if (code <= 48) return { icon: "🌫", label: "Foggy" };
  if (code <= 57) return { icon: "🌦", label: "Drizzle" };
  if (code <= 67) return { icon: "🌧", label: "Rain" };
  if (code <= 82) return { icon: "🌧", label: "Showers" };
  if (code <= 86) return { icon: "🌨", label: "Snow showers" };
  return { icon: "⛈", label: "Thunderstorm" };
}

type Day = {
  icon: string;
  label: string;
  max: number;
  min: number;
  rain: number;
  sunrise: string;
  sunset: string;
  hours: { time: string; icon: string; temp: number; rain: number; wind: number }[];
};

/**
 * Weather chip on a lead tile: shows the test-drive-day summary and pops up
 * the full forecast for that day when clicked. Fetched straight from
 * Open-Meteo in the browser — no key, nothing stored.
 */
export default function TestDriveWeather({
  date,
  when,
  summary,
}: {
  date: string; // yyyy-mm-dd
  when: string; // "Wed 8 Jul 14:00"
  summary: string; // "🌤 22°"
}) {
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState<Day | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open || day) return;
    fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=-33.925&longitude=18.48&hourly=temperature_2m,precipitation_probability,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset&timezone=Africa%2FJohannesburg&start_date=${date}&end_date=${date}`
    )
      .then((r) => r.json())
      .then((j) => {
        const d = wmo(j.daily?.weather_code?.[0] ?? 0);
        const hours = (j.hourly?.time ?? [])
          .map((t: string, i: number) => ({
            time: t.slice(11, 16),
            hour: Number(t.slice(11, 13)),
            icon: wmo(j.hourly.weather_code?.[i] ?? 0).icon,
            temp: Math.round(j.hourly.temperature_2m?.[i] ?? 0),
            rain: Math.round(j.hourly.precipitation_probability?.[i] ?? 0),
            wind: Math.round(j.hourly.wind_speed_10m?.[i] ?? 0),
          }))
          .filter((h: { hour: number }) => h.hour >= 7 && h.hour <= 19);
        setDay({
          icon: d.icon,
          label: d.label,
          max: Math.round(j.daily?.temperature_2m_max?.[0] ?? 0),
          min: Math.round(j.daily?.temperature_2m_min?.[0] ?? 0),
          rain: Math.round(j.daily?.precipitation_probability_max?.[0] ?? 0),
          sunrise: (j.daily?.sunrise?.[0] ?? "").slice(11, 16),
          sunset: (j.daily?.sunset?.[0] ?? "").slice(11, 16),
          hours,
        });
      })
      .catch(() => setFailed(true));
  }, [open, day, date]);

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className="text-xs rounded-md bg-sky-500/10 border border-sky-500/20 px-1.5 py-0.5 text-sky-300 hover:bg-sky-500/20 transition-colors cursor-pointer"
        title="Full forecast for the test drive day"
      >
        {summary}
      </button>
      {open && (
        <ModalPortal>
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(false);
          }}
        >
          <div
            className="card w-full max-w-sm p-0 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
              <p className="text-sm font-semibold text-slate-200">🚗 Test drive · {when}</p>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-slate-400 hover:text-white text-lg leading-none cursor-pointer"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            {!day && !failed && (
              <p className="px-4 py-6 text-sm text-slate-400 text-center">Loading forecast…</p>
            )}
            {failed && (
              <p className="px-4 py-6 text-sm text-slate-400 text-center">
                Couldn&apos;t load the forecast right now.
              </p>
            )}
            {day && (
              <div className="p-4 space-y-3">
                <div className="flex items-center gap-3">
                  <span className="text-4xl">{day.icon}</span>
                  <div>
                    <p className="font-semibold text-white">
                      {day.label} · {day.max}° <span className="text-slate-400 font-normal">/ {day.min}°</span>
                    </p>
                    <p className="text-xs text-slate-400">
                      💧 {day.rain}% rain · 🌅 {day.sunrise} · 🌇 {day.sunset} · Cape Town
                    </p>
                  </div>
                </div>
                <div className="overflow-x-auto -mx-1 px-1">
                  <div className="flex gap-1.5 pb-1">
                    {day.hours.map((h) => (
                      <div
                        key={h.time}
                        className="shrink-0 w-14 rounded-lg bg-slate-800/70 border border-slate-700/60 py-1.5 text-center"
                      >
                        <p className="text-[10px] text-slate-400">{h.time}</p>
                        <p className="text-base leading-tight">{h.icon}</p>
                        <p className="text-xs font-semibold text-white">{h.temp}°</p>
                        <p className="text-[10px] text-sky-400">{h.rain > 0 ? `${h.rain}%` : "—"}</p>
                        <p className="text-[10px] text-slate-500">{h.wind}km/h</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
        </ModalPortal>
      )}
    </>
  );
}

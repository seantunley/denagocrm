/**
 * Cape Town daily forecast (Open-Meteo, keyless), cached in-memory for 30
 * minutes. Used to show test-drive-day weather on lead cards.
 */
export function wmoIcon(code: number): string {
  if (code === 0) return "☀️";
  if (code <= 2) return "🌤";
  if (code === 3) return "☁️";
  if (code <= 48) return "🌫";
  if (code <= 57) return "🌦";
  if (code <= 67) return "🌧";
  if (code <= 82) return "🌧";
  if (code <= 86) return "🌨";
  return "⛈";
}

export type DayForecast = { icon: string; maxTemp: number; rainChance: number };

let cache: { at: number; days: Map<string, DayForecast> } | null = null;

export async function getDailyForecast(): Promise<Map<string, DayForecast>> {
  if (cache && Date.now() - cache.at < 30 * 60 * 1000) return cache.days;
  const days = new Map<string, DayForecast>();
  try {
    const res = await fetch(
      "https://api.open-meteo.com/v1/forecast?latitude=-33.925&longitude=18.48&daily=weather_code,temperature_2m_max,precipitation_probability_max&timezone=Africa%2FJohannesburg&forecast_days=14",
      { cache: "no-store" }
    );
    if (!res.ok) return days;
    const j = await res.json();
    const dates: string[] = j.daily?.time ?? [];
    dates.forEach((date, i) => {
      days.set(date, {
        icon: wmoIcon(j.daily.weather_code?.[i] ?? 0),
        maxTemp: Math.round(j.daily.temperature_2m_max?.[i] ?? 0),
        rainChance: Math.round(j.daily.precipitation_probability_max?.[i] ?? 0),
      });
    });
    cache = { at: Date.now(), days };
  } catch {
    // no forecast is fine — cards just skip the weather line
  }
  return days;
}

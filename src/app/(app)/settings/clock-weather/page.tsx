import { requireOwner } from "@/lib/auth";
import { getSetting } from "@/lib/settings";
import { SettingsWorkspace } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";
import WeatherCitiesSettings from "@/components/settings/WeatherCitiesSettings";
import { WEATHER_CITIES_KEY, parseWeatherCities } from "@/lib/weatherCities";

export const dynamic = "force-dynamic";

/**
 * Which cities appear in the clock/weather strip, for this workspace.
 *
 * Its own page under Organisation rather than a section bolted onto another
 * one: it is a workspace-wide display choice, like the company profile, and the
 * settings index is a catalogue — anything not listed there is effectively
 * unfindable. The first version of this put the editor beside the pipeline
 * stages, where nobody would ever look for it.
 *
 * `requireOwner` here as well as in the action. The action is the thing that
 * actually protects the write; this stops a member being shown a page whose
 * every control would refuse them.
 */
export default async function ClockWeatherSettingsPage() {
  await requireOwner();
  const cities = parseWeatherCities(await getSetting(WEATHER_CITIES_KEY));

  return (
    <SettingsWorkspace
      current="clock-weather"
      title="Clock & weather"
      description="The date, time and weather strip at the top of every page. Pick the cities this workspace cares about — everyone here sees the same ones."
      groups={SETTINGS_NAV_GROUPS}
    >
      <WeatherCitiesSettings initial={cities} />
    </SettingsWorkspace>
  );
}

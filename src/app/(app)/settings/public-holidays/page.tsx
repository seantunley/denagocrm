import Link from "next/link";
import { requireTenantOwner } from "@/lib/auth";
import { getSetting } from "@/lib/settings";
import { SettingsWorkspace } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { StatusPill, Surface } from "@/components/visual-system";
import { PUBLIC_HOLIDAYS_KEY, holidaysFor, missingYears, parseHolidaySetting } from "@/lib/publicHolidays";
import { holidayCountries } from "@/lib/publicHolidaysFetch";
import { addClosedDay, refreshHolidays, removeClosedDay, setHolidayCountry, toggleSkipHoliday } from "@/app/actions/publicHolidays";

export const dynamic = "force-dynamic";

/**
 * The workspace's public holidays and its own closed days (Sean, 2026-11-02). Used by the chatbot's Opening hours
 * step, which treats them as closed. South Africa is built in; another country's are loaded from a public holiday
 * calendar when chosen. Owner only, as every action here is.
 */
export default async function PublicHolidaysSettingsPage() {
  await requireTenantOwner();
  const [setting, countries] = await Promise.all([getSetting(PUBLIC_HOLIDAYS_KEY).then(parseHolidaySetting), holidayCountries()]);
  const year = Number(new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 4));
  const years = [year, year + 1];
  const missing = missingYears(setting, years);
  const weekday = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-ZA", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

  return (
    <SettingsWorkspace
      current="public-holidays"
      title="Public holidays"
      description="The days your business is closed: your country's public holidays and your own closed days. The chatbot's Opening hours step treats them as closed."
      groups={SETTINGS_NAV_GROUPS}
    >
      <div className="space-y-4">
        <Surface className="p-4">
          <SaveForm action={setHolidayCountry} success="Country saved" className="flex flex-wrap items-end gap-3">
            <div className="min-w-60 flex-1">
              <label className="label" htmlFor="holiday-country">Country</label>
              <select id="holiday-country" name="country" className="input" defaultValue={setting.country}>
                {countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </select>
            </div>
            <SaveButton className="btn-primary btn-sm">Use this country</SaveButton>
          </SaveForm>
          <p className="mt-2 text-xs text-muted-foreground">
            {setting.country === "ZA"
              ? "South Africa's holidays are built in, Easter dates and Sunday-to-Monday included — nothing to load."
              : `${setting.countryName}'s holidays are loaded from a public holiday calendar (date.nager.at) for this year and next. Regional ones say which regions — skip any your business stays open on.`}
          </p>
          {missing.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
              <span>{missing.join(" and ")} {missing.length === 1 ? "isn't" : "aren't"} loaded yet, so no holidays count for {missing.length === 1 ? "it" : "them"}.</span>
              <SaveForm action={refreshHolidays} success="Holidays refreshed"><SaveButton className="btn-secondary btn-sm">Load now</SaveButton></SaveForm>
            </div>
          )}
        </Surface>

        <div className="grid gap-4 lg:grid-cols-2">
          {years.map((y) => {
            const list = holidaysFor(setting, y);
            return (
              <Surface key={y} className="p-4">
                <h2 className="font-semibold">{y}</h2>
                {list.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">Nothing for {y} yet.</p> : (
                  <ul className="mt-2 divide-y divide-border/70">
                    {list.map((h) => (
                      <li key={`${h.date}-${h.name}`} className={`flex items-center justify-between gap-3 py-1.5 text-sm ${h.skipped ? "opacity-50" : ""}`}>
                        <span className="min-w-0"><span className="inline-block w-28 text-muted-foreground">{weekday(h.date)}</span>{h.name}</span>
                        <span className="flex shrink-0 items-center gap-2">
                          {h.custom ? <StatusPill tone="info">Your closed day</StatusPill> : h.skipped ? <StatusPill tone="neutral">Open that day</StatusPill> : null}
                          {h.custom ? (
                            <SaveForm action={removeClosedDay.bind(null, h.date)} success="Removed"><SaveButton className="btn-secondary btn-sm text-red-300">Remove</SaveButton></SaveForm>
                          ) : (
                            <SaveForm action={toggleSkipHoliday.bind(null, h.date)} success="Saved"><SaveButton className="btn-secondary btn-sm">{h.skipped ? "Close" : "Skip"}</SaveButton></SaveForm>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Surface>
            );
          })}
        </div>

        <Surface className="p-4">
          <h2 className="font-semibold">Add a closed day</h2>
          <p className="mt-1 text-xs text-muted-foreground">A day your business is closed that isn&apos;t a public holiday — a year-end shutdown, a stocktake day.</p>
          <SaveForm action={addClosedDay} success="Closed day added" className="mt-3 grid gap-3 sm:grid-cols-[12rem_1fr_auto] sm:items-end">
            <div><label className="label" htmlFor="closed-date">Date</label><input id="closed-date" name="date" type="date" className="input" required /></div>
            <div><label className="label" htmlFor="closed-name">Name</label><input id="closed-name" name="name" className="input" required maxLength={80} placeholder="Year-end shutdown" /></div>
            <SaveButton className="btn-primary btn-sm">Add</SaveButton>
          </SaveForm>
        </Surface>

        <p className="text-xs text-muted-foreground">Office hours themselves are set on the <Link href="/chatbot" className="underline">Chatbot page</Link>.</p>
      </div>
    </SettingsWorkspace>
  );
}

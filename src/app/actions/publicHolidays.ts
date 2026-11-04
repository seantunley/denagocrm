"use server";

import { revalidatePath } from "next/cache";
import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { requireTenantOwner } from "@/lib/auth";
import { getSetting, putSetting } from "@/lib/settings";
import { logAudit } from "@/lib/audit";
import { PUBLIC_HOLIDAYS_KEY, parseHolidaySetting, type HolidaySetting } from "@/lib/publicHolidays";
import { fetchCountryHolidays, holidayCountries } from "@/lib/publicHolidaysFetch";

/** Settings → Public holidays (lib/publicHolidays.ts). Owner only; every change audited. */

const PAGE = "/settings/public-holidays";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const thisYear = () => Number(new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 4));

async function current(): Promise<HolidaySetting> {
  return parseHolidaySetting(await getSetting(PUBLIC_HOLIDAYS_KEY));
}
async function save(next: HolidaySetting, summary: string, user: Awaited<ReturnType<typeof requireTenantOwner>>) {
  await putSetting(PUBLIC_HOLIDAYS_KEY, JSON.stringify(next));
  await logAudit({ action: "settings.public_holidays", summary, user });
  revalidatePath(PAGE);
}

/** Load a country's holidays for this year and next — refused, and nothing changed, if the calendar can't be reached. */
async function loadYears(country: string): Promise<Record<string, HolidaySetting["loaded"][string]> | null> {
  if (country === "ZA") return {};
  const years = [thisYear(), thisYear() + 1];
  const lists = await Promise.all(years.map((year) => fetchCountryHolidays(country, year)));
  if (lists.some((list) => list === null)) return null;
  return Object.fromEntries(years.map((year, i) => [String(year), lists[i]!]));
}

export async function setHolidayCountry(formData: FormData): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    const code = String(formData.get("country") ?? "").toUpperCase();
    const country = (await holidayCountries()).find((c) => c.code === code);
    if (!country) refuse("Choose a country from the list.");
    const loaded = await loadYears(country.code);
    if (!loaded) refuse(`Couldn't load ${country.name}'s holidays just now — try again in a minute.`);
    const before = await current();
    // A new country's holidays start with nothing skipped; the workspace's own closed days stay.
    await save({ country: country.code, countryName: country.name, loaded, custom: before.custom, skipped: before.country === country.code ? before.skipped : [] }, `Public holidays: ${country.name}`, user);
    return { success: `Public holidays: ${country.name}` };
  });
}

export async function refreshHolidays(): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    const before = await current();
    const loaded = await loadYears(before.country);
    if (!loaded) refuse(`Couldn't reach the holiday calendar just now — try again in a minute.`);
    await save({ ...before, loaded }, `Public holidays refreshed: ${before.countryName}`, user);
    return { success: "Holidays refreshed" };
  });
}

export async function addClosedDay(formData: FormData): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    const date = String(formData.get("date") ?? "");
    const name = String(formData.get("name") ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!DATE.test(date)) refuse("Choose a date.");
    if (!name) refuse("Give the day a name, e.g. Year-end shutdown.");
    const before = await current();
    if (before.custom.some((h) => h.date === date)) refuse("That day is already one of your closed days.");
    await save({ ...before, custom: [...before.custom, { date, name }].sort((a, b) => a.date.localeCompare(b.date)) }, `Closed day added: ${date} — ${name}`, user);
    return { success: "Closed day added" };
  });
}

export async function removeClosedDay(date: string): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    const before = await current();
    await save({ ...before, custom: before.custom.filter((h) => h.date !== date) }, `Closed day removed: ${date}`, user);
    return { success: "Closed day removed" };
  });
}

/** Skip (or stop skipping) one of the country's holidays — e.g. a regional one the business stays open on. */
export async function toggleSkipHoliday(date: string): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    if (!DATE.test(date)) refuse("That isn't a date.");
    const before = await current();
    const skipping = !before.skipped.includes(date);
    await save({ ...before, skipped: skipping ? [...before.skipped, date] : before.skipped.filter((d) => d !== date) }, `Public holiday ${date} ${skipping ? "skipped — open that day" : "observed again"}`, user);
    return { success: skipping ? "Open on that day" : "Closed on that day again" };
  });
}

import { getSetting } from "./settings";
import { isOpenAt } from "./openingHours";
import { PUBLIC_HOLIDAYS_KEY, isHoliday, parseHolidaySetting } from "./publicHolidays";

/**
 * Is the business open now, by the chatbot's office hours (Chatbot page: BOT_HOURS, BOT_DAYS) — and, when asked,
 * not on one of the workspace's public holidays or closed days (Settings → Public holidays)? The Opening hours step
 * and the old auto-reply both ask this.
 */
export async function chatbotOpenNow(holidaysClosed: boolean, now = new Date()): Promise<boolean> {
  const [hours, days, holidays] = await Promise.all([
    getSetting("BOT_HOURS"),
    getSetting("BOT_DAYS"),
    holidaysClosed ? getSetting(PUBLIC_HOLIDAYS_KEY) : Promise.resolve(null),
  ]);
  const setting = holidaysClosed ? parseHolidaySetting(holidays) : null;
  return isOpenAt(now, { hours, days }, setting ? { isHoliday: (dateKey) => isHoliday(setting, dateKey) } : {});
}

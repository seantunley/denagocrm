/**
 * When a scheduled email can go. The scheduled-emails cron runs on the hour and
 * the half hour (vercel.json — its cadence is a database bill), so the composer
 * offers exactly those times: what the person picks is when it goes.
 */
const HALF_HOUR = 30 * 60 * 1000;

/** The first :00 or :30 at or after `at` (seconds dropped). */
export function nextHalfHour(at: Date): Date {
  const t = Math.ceil(at.getTime() / HALF_HOUR) * HALF_HOUR;
  return new Date(t);
}

/** A time as an <input type="datetime-local"> value, in the browser's own zone. */
export function localInputValue(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** The quick choices, as Outlook offers them: in an hour, tomorrow morning, Monday morning. */
export function quickSendTimes(now: Date): { label: string; at: Date }[] {
  const morning = (days: number) => {
    const at = new Date(now);
    at.setDate(at.getDate() + days);
    at.setHours(8, 0, 0, 0);
    return at;
  };
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  const options = [
    { label: "In an hour", at: nextHalfHour(new Date(now.getTime() + 60 * 60 * 1000)) },
    { label: "Tomorrow 08:00", at: morning(1) },
  ];
  // Monday is only worth offering when it is not tomorrow.
  if (toMonday > 1) options.push({ label: "Monday 08:00", at: morning(toMonday) });
  return options;
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const JOHANNESBURG_OFFSET = "+02:00";

function assertDateKey(dateKey: string) {
  if (!DATE_KEY.test(dateKey)) throw new Error(`Invalid calendar date: ${dateKey}`);
}

export function johannesburgMidnight(dateKey: string): Date {
  assertDateKey(dateKey);
  return new Date(`${dateKey}T00:00:00${JOHANNESBURG_OFFSET}`);
}

export function calendarQueryBounds(gridStartKey: string, gridEndKey: string) {
  return {
    start: johannesburgMidnight(gridStartKey),
    end: johannesburgMidnight(gridEndKey),
  };
}

export function isCalendarEventOverdue(input: {
  status: string;
  dueDate: Date;
  dateOnly: boolean;
  now: Date;
  todayKey: string;
}): boolean {
  if (input.status !== "planned") return false;
  const cutoff = input.dateOnly ? johannesburgMidnight(input.todayKey) : input.now;
  return input.dueDate < cutoff;
}

export function shiftDateKey(dateKey: string, days: number): string {
  assertDateKey(dateKey);
  const [year, month, day] = dateKey.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

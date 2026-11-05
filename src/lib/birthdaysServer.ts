import "server-only";
import { cache } from "react";
import { prisma } from "./db";
import { getAccessibleContactIds, hasAnyPermission, hasPermission, type PermissionUser } from "./permissions";
import { birthdayKeys, nextDays, type MonthDay } from "./birthdays";

/** How many customers one section of the Birthdays page lists before saying "and N more". */
export const BIRTHDAY_LIST_LIMIT = 200;

/**
 * Which customers this person may open, as a filter — WITHOUT listing every id when they may see all (review of #1008:
 * the top-bar count read every customer id in the workspace on every page). Seeing all: no filter — the scoped
 * client keeps it to the acting workspace, as the CRM's own lists do. Only their own: the ids of their own book
 * (getAccessibleContactIds, bounded by what they own). Null: none.
 */
async function contactFilter(user: PermissionUser): Promise<Record<string, unknown> | null> {
  if (!(await hasAnyPermission(user, "contacts.view_all", "contacts.view_owned"))) return null;
  if (await hasPermission(user, "contacts.view_all")) return {};
  const ids = await getAccessibleContactIds(user);
  if (ids === null) return {};
  return ids.length ? { id: { in: ids } } : null;
}

const onDays = (keys: readonly MonthDay[]) => ({ OR: keys.map((k) => ({ birthMonth: k.month, birthDay: k.day })) });

const SELECT = {
  id: true, firstName: true, lastName: true, company: true, isCompany: true, phone: true, whatsapp: true, email: true,
  birthDay: true, birthMonth: true, birthYear: true, owner: { select: { name: true } },
} as const;

/**
 * Whose birthdays fall on these calendar days, IN DAY ORDER (one indexed query per day, so the week across New Year
 * lists December before January), with the true total. At most `limit` rows; `total` says how many there are.
 */
export async function birthdaysOn(user: PermissionUser, days: readonly { year: number; month: number; day: number }[], limit = BIRTHDAY_LIST_LIMIT) {
  const filter = await contactFilter(user);
  if (!filter || !days.length) return { rows: [], total: 0 };
  const total = await prisma.contact.count({ where: { ...filter, ...onDays(birthdayKeys(days)) } });
  const rows = [];
  for (const day of days) {
    if (rows.length >= limit) break;
    rows.push(...(await prisma.contact.findMany({
      where: { ...filter, ...onDays(birthdayKeys([day])) },
      select: SELECT,
      orderBy: [{ firstName: "asc" }, { id: "asc" }],
      take: limit - rows.length,
    })));
  }
  return { rows, total };
}

/** For the cake in the top bar: a COUNT in the database, nothing listed. Once per request. */
export const todaysBirthdayCount = cache(async (user: PermissionUser): Promise<number> => {
  const filter = await contactFilter(user);
  if (!filter) return 0;
  return prisma.contact.count({ where: { ...filter, ...onDays(birthdayKeys(nextDays(1))) } });
});

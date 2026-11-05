import "server-only";
import { cache } from "react";
import { prisma } from "./db";
import { getAccessibleContactIds, hasAnyPermission, type PermissionUser } from "./permissions";
import { birthdayKeys, nextDays, type MonthDay } from "./birthdays";

/**
 * Whose birthdays fall on these days — only customers this person may open (the CRM's own contact access), in the
 * acting workspace (the scoped client). An empty access list is nobody, never everybody.
 */
export async function birthdaysOn(user: PermissionUser, keys: readonly MonthDay[]) {
  if (!keys.length || !(await hasAnyPermission(user, "contacts.view_all", "contacts.view_owned"))) return [];
  const ids = await getAccessibleContactIds(user);
  if (ids !== null && ids.length === 0) return [];
  return prisma.contact.findMany({
    where: {
      ...(ids === null ? {} : { id: { in: ids } }),
      OR: keys.map((k) => ({ birthMonth: k.month, birthDay: k.day })),
    },
    select: {
      id: true, firstName: true, lastName: true, company: true, isCompany: true, phone: true, whatsapp: true, email: true,
      birthDay: true, birthMonth: true, birthYear: true, owner: { select: { name: true } },
    },
    orderBy: [{ birthMonth: "asc" }, { birthDay: "asc" }, { firstName: "asc" }],
    take: 500,
  });
}

/** For the cake in the top bar: how many of this person's customers have a birthday today. Once per request. */
export const todaysBirthdayCount = cache(async (user: PermissionUser): Promise<number> => {
  return (await birthdaysOn(user, birthdayKeys(nextDays(1)))).length;
});

import "server-only";
import { cache } from "react";
import { prisma } from "@/lib/db";

/**
 * User id → display name, memoised per request.
 *
 * The `user` field type stores an id — `assignedToId`, `ownerId`, `technicianId`
 * — because that is the column, and `compileSelect` faithfully selects it. A
 * dashboard column reading `cmk3n1x8p0004…` is worse than an empty one, so
 * something has to resolve it, and the two places it could happen are both
 * wrong:
 *
 *   In the compiler, by joining the user relation into every list query. That
 *   makes every card carrying an owner column a join it did not ask for, and it
 *   puts a display concern inside the thing whose job is the security boundary.
 *
 *   Per row, in the renderer. That is twelve round trips for a twelve-row card,
 *   and forty cards of it on one screen.
 *
 * So it is one query, once, wrapped in React's `cache()` — the same per-request
 * memoisation every export in lib/dashboard/data.ts uses. Two list cards showing
 * an owner column cost one lookup between them, and a page with no owner column
 * anywhere never calls this at all: ./list.tsx only reaches for it when a `user`
 * column is actually on the card.
 *
 * NOTHING SENSITIVE IS FETCHED. Ids and names, which is what every record page,
 * agenda row and assignee picker in the app already shows. The people who may be
 * ASSIGNED work are not a secret; which records they are assigned is, and that
 * is decided by the row scope long before this is called.
 */
export const userNames = cache(async (): Promise<ReadonlyMap<string, string>> => {
  const users = await prisma.user.findMany({ select: { id: true, name: true } });
  return new Map(users.map((user) => [user.id, user.name]));
});

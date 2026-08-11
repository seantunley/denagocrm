import "server-only";
import { cache } from "react";
import { listActingTenantStaff } from "@/lib/tenantActor";

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
 * Ids and names, which is what every record page, agenda row and assignee picker
 * in the app already shows — WITHIN A WORKSPACE. Across workspaces it is a staff
 * directory, and this was `prisma.user.findMany` with no filter at all: `User` is
 * a global model, so the map held every person on the platform. A dashboard only
 * renders the names its rows point at, so nothing leaked through the cards
 * themselves; what leaked was the possibility, and the map is the wrong place to
 * be relying on a downstream filter for that.
 *
 * `listActingTenantStaff` is the acting-workspace list — the same one the
 * assignee pickers now build from, so a name a card resolves is a name that card
 * could have offered. It is the ACTING variant deliberately: the background
 * `listTenantStaff` skips its TenantMember join while enforcement is dormant,
 * which is every environment today, and would have left this exactly as
 * unscoped as the query it replaces. A dashboard is always rendered to a
 * signed-in person, so the session is there to resolve.
 *
 * An id with no entry falls back to whatever ./list.tsx shows for an unresolved
 * user, which is the correct outcome for a row owned by somebody outside this
 * workspace: no name.
 */
export const userNames = cache(async (): Promise<ReadonlyMap<string, string>> => {
  const users = await listActingTenantStaff();
  return new Map(users.map((user) => [user.id, user.name]));
});

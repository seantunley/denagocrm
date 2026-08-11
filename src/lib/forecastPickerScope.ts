/**
 * TWO AXES, AND THE ONE THE FORECAST PAGE KEPT CONFUSING FOR THE OTHER.
 *
 * `getAccessibleLeadScope(user).viewAll` — granted by `leads.view_all`, and
 * unconditionally to a global `owner` — answers ONE question:
 *
 *     WITHIN this workspace, may this person see records that are not theirs?
 *
 * It has never answered, and cannot answer:
 *
 *     WHICH WORKSPACE'S records and people are these?
 *
 * The /forecast page ran both questions through the same `if`. Its `Team`, `User`
 * and `TeamMember` reads were global — no tenant predicate of any kind, on
 * `basePrisma`, the documented RLS bypass — and `viewAll` was the only thing
 * standing between the caller and the whole platform:
 *
 *     const teams = scope.viewAll ? allTeams : allTeams.filter(…)
 *     if (scope.viewAll) for (const item of allUsers) visibleUserIds.add(item.id)
 *
 * `allTeams` and `allUsers` were EVERY workspace's. So the sales manager who had
 * been given "see the whole team's pipeline" was, by the same click, given every
 * other dealer's team names and staff names in two dropdowns — and every owner
 * had it by default. The permission was doing a job nobody granted it.
 *
 * THE SEPARATION THIS MODULE ENFORCES: the workspace boundary is applied by the
 * QUERY, before anything here runs, and is deliberately NOT an input to this
 * function. `workspaceTeams`, `workspaceStaff` and `workspaceMemberships` are
 * already one workspace's — `listActingTenantTeams`, `listActingTenantStaff` and
 * `listActingTenantTeamMemberships`, all classified by `actingScopeClass()` so the
 * boundary is real while enforcement is dormant. What is left for `viewAll` to do
 * is choose AMONG them, and the widest thing it can now return is everything it
 * was handed. A `viewAll` user sees every lead in their own workspace and nobody
 * else's staff, and the type signature is why: there is no argument to this
 * function that could widen the set, whatever `viewAll` says.
 *
 * Pure and import-free so `tests/forecastStaffScope.test.ts` can EXECUTE it with a
 * two-workspace fixture rather than pattern-match the page. The page is a React
 * server component; a rule left inside one can only ever be grepped for.
 */

/** A team as the picker offers it. */
export type PickerTeam = { id: string; name: string };
/** A person as the picker offers them. */
export type PickerPerson = { id: string; name: string };
/** Who is in which team, for widening "my teams" into "my teams' people". */
export type PickerMembership = { teamId: string; userId: string };

/**
 * `getAccessibleLeadScope`'s answer, narrowed to what a picker needs. Note what
 * is NOT here: a tenant. This is the record-visibility axis and nothing else.
 */
export type RecordScope = {
  /** May they see records that are not their own — INSIDE their workspace? */
  viewAll: boolean;
  /** The signed-in person, who is always an option to themselves. */
  userId: string;
  /** The teams they belong to or manage. */
  teamIds: string[];
};

export type ForecastPickers = {
  /** The teams offered by the Team filter, and accepted from `?team=`. */
  teams: PickerTeam[];
  /** The people offered by the Owner filter, and accepted from `?user=`. */
  users: PickerPerson[];
};

/**
 * The options the two forecast filters may offer, given ONE workspace's teams,
 * staff and memberships and the caller's record-visibility scope.
 *
 * `viewAll` widens from "my teams and their people" to "the workspace's teams and
 * its people" — and stops there, because that is all it was given.
 */
export function forecastPickers(input: {
  workspaceTeams: PickerTeam[];
  workspaceStaff: PickerPerson[];
  workspaceMemberships: PickerMembership[];
  scope: RecordScope;
}): ForecastPickers {
  const { workspaceTeams, workspaceStaff, workspaceMemberships, scope } = input;

  const teams = scope.viewAll
    ? workspaceTeams
    : workspaceTeams.filter((team) => scope.teamIds.includes(team.id));

  // The caller themselves is always selectable — but only as a member of the
  // workspace's staff list, which is the filter applied at the end. Seeding the
  // id here and admitting it unconditionally are different things, and the
  // difference is whether an actor outside the acting workspace can name
  // themselves in it.
  const visibleUserIds = new Set<string>([scope.userId]);
  if (scope.viewAll) {
    for (const person of workspaceStaff) visibleUserIds.add(person.id);
  } else {
    for (const membership of workspaceMemberships) {
      if (scope.teamIds.includes(membership.teamId)) visibleUserIds.add(membership.userId);
    }
  }

  return {
    teams,
    users: workspaceStaff.filter((person) => visibleUserIds.has(person.id)),
  };
}

/**
 * Honour a `?team=` / `?user=` id only if the picker would have offered it.
 *
 * The query string is client-supplied, so this is the boundary a hand-typed URL
 * meets rather than a convenience. Both filters feed `listForecastLeads`, and an
 * id that survived without being offered would turn the filter into an existence
 * oracle for another workspace's teams and people.
 */
export function offeredId<T extends { id: string }>(options: T[], requested: string | null): string | null {
  if (!requested) return null;
  return options.some((option) => option.id === requested) ? requested : null;
}

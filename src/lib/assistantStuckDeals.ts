import "server-only";
import { prisma } from "./db";
import { getAccessibleLeadIds, hasAnyPermission, type PermissionUser } from "./permissions";
import { stuckLookup } from "./assistantStuckLookup";
import { overLimit } from "./assistantStuck";

/**
 * The `stuck_deals` lookup (round 2, item 7 — the Monday brief): the person's MOST-stuck open deals, each with its
 * top reason from the one-deal `stuck` check (assistantStuckLookup — the same ranked, dated, linked reasons, never
 * re-derived here). "Most stuck" = furthest past its stage's time limit (assistantStuck.overLimit).
 * Theirs = assigned to them or to nobody (the daily brief's "mine"); the team's = the
 * other open deals in their own lead list, so it is empty for someone who sees only their own. READ-ONLY.
 */

type Output = { rows: { label: string; detail: string; href: string }[]; data: unknown[]; truncated: boolean };
const MINE_SHOWN = 3;
const TEAM_SHOWN = 5;

export async function stuckDealsLookup(user: PermissionUser, now = new Date()): Promise<Output> {
  if (!(await hasAnyPermission(user, "leads.view_all", "leads.view_owned"))) return { truncated: false, rows: [], data: [{ note: "You don't have access to leads." }] };
  const ids = await getAccessibleLeadIds(user);
  const open = ids !== null && ids.length === 0 ? [] : await prisma.lead.findMany({
    where: { deletedAt: null, status: "open", ...(ids === null ? {} : { id: { in: ids } }) },
    select: { id: true, assignedToId: true, stageEnteredAt: true, stage: { select: { staleAfterDays: true } } },
    take: 2000,
  });
  const worst = (rows: typeof open, n: number) =>
    rows
      .map((l) => ({ id: l.id, over: overLimit(l.stageEnteredAt, l.stage.staleAfterDays, now) }))
      .filter((l) => l.over >= 0)
      .sort((a, b) => b.over - a.over)
      .slice(0, n);
  const mine = worst(open.filter((l) => l.assignedToId === user.id || l.assignedToId === null), MINE_SHOWN);
  const team = worst(open.filter((l) => l.assignedToId !== null && l.assignedToId !== user.id), TEAM_SHOWN);

  // The one-deal check on each: its top reason, exactly as `stuck` states it.
  const check = async (id: string) => {
    const out = await stuckLookup(user, id);
    const d = out.data[0] as { deal?: unknown; reasons?: { why: string; date?: string; link: string }[] } | undefined;
    return { deal: d?.deal, topReason: d?.reasons?.[0] ?? "nothing in the records is holding it up", link: out.rows[0]?.href ?? `/leads/${id}` };
  };
  const [mineChecked, teamChecked] = [await Promise.all(mine.map((l) => check(l.id))), await Promise.all(team.map((l) => check(l.id)))];
  return {
    truncated: open.length === 2000,
    rows: [...mine, ...team].map((l, i) => ({ label: `Stuck deal ${i + 1}`, detail: `${l.over} days past its stage's limit`, href: `/leads/${l.id}` })),
    data: [{
      rule: "Most stuck = furthest past its stage's time limit. Give each deal its link and its top reason exactly as stated; nothing else is a fact.",
      mine: mineChecked.length ? mineChecked : "none of theirs is past its stage's time limit",
      ...(teamChecked.length ? { team: teamChecked } : {}),
    }],
  };
}

import "server-only";
import { cache } from "react";
import { dashboardViewer, dashboardWindow } from "./data";
import { localClock, type ConditionContext } from "./conditions";

/**
 * Everything a visibility condition can ask about, resolved once per request.
 *
 * ── WHY THE CLOCK IS THE WORKSPACE'S AND NOT THE SERVER'S ───────────────────
 *
 * A `time` condition is written by someone who means their own working day —
 * "show the workshop board between seven and five". The server runs in UTC, and
 * on a UTC clock a South African workday starts at five in the morning, so a
 * card configured for business hours would appear two hours early and vanish two
 * hours early. Nobody would report that as a timezone bug; they would report
 * that the dashboard is wrong in the afternoon.
 *
 * `Intl` is used rather than an offset constant because the offset is a fact
 * about a date, not about a place. South Africa does not observe daylight saving
 * today, but hardcoding +02:00 would make that a permanent assumption buried in
 * a dashboard module, and the first person to hit it would be looking at a card,
 * not at this file.
 */

/**
 * The condition context for this request.
 *
 * Memoised, and it matters more here than it looks: every view, every section
 * and every card is evaluated against this, so a dashboard with thirty cards
 * would otherwise resolve the permission list thirty times. It also has to be
 * ONE snapshot — two cards deciding visibility from clocks a few milliseconds
 * apart could straddle a `time` boundary and produce a screen where a card
 * appears and its heading does not.
 */
export const viewerConditionContext = cache(async (): Promise<Omit<ConditionContext, "signals">> => {
  const [{ user, access }, window] = await Promise.all([dashboardViewer(), dashboardWindow()]);
  const { minutes, weekday } = localClock(window.now);
  return {
    userId: user.id,
    role: user.role,
    permissions: access.permissions,
    modules: access.modules,
    now: window.now,
    localMinutes: minutes,
    localWeekday: weekday,
  };
});

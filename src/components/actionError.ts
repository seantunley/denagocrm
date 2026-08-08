/**
 * What to say when a server action THROWS instead of returning.
 *
 * After lib/actionResult.ts, a genuine server-side failure comes back as a
 * VALUE — `{ error: "… Reference K7QP2M" }` — logged with that reference. So an
 * error that still arrives here as a throw did not fail inside the action: the
 * call never completed. In practice that is one of two things, and the same
 * sentence is the right advice for both:
 *
 *   - THE TAB IS OLDER THAN THE DEPLOYMENT. Every server action is identified by
 *     an id baked into the build, and a new deployment issues new ids, so a page
 *     left open across a deploy calls an id the server no longer has. Next's own
 *     deployment guidance is to surface this as a retry path rather than a hard
 *     failure, because a refresh genuinely fixes it.
 *   - The network dropped, or the request never landed.
 *
 * This cost an afternoon once: a tenant logo that would not save, with
 * "Something went wrong. Please try again." on screen. Nothing had gone wrong
 * with the logo, and trying again could never have worked — the tab was twenty
 * minutes older than the running build. The sentence below is the one that would
 * have ended it immediately.
 *
 * Deliberately NOT a reference code: in the stale-tab case nothing was logged
 * server-side, because nothing reached the server. Offering a reference that
 * matches no log line would be worse than offering none.
 *
 * AND IT DOES NOT CLAIM NOTHING WAS SAVED. That is true of the stale-tab case and
 * NOT of the other one: if the connection dropped after the server had already
 * processed the action, the write happened and only the response was lost. From
 * the browser the two are indistinguishable, so the honest wording covers both —
 * same reasoning as the unexpected-failure message in lib/actionFailure.ts, which
 * made the identical mistake for the identical reason.
 */
export const ACTION_NOT_DELIVERED =
  "No reply from the server, so this may not have been applied. Check the record before retrying — if this page has been open a while, refresh it first.";

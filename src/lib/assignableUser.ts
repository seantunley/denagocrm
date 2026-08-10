/**
 * Who a tenant-owned record may be ASSIGNED to — the rule, in one place.
 *
 * `User` is a GLOBAL model by design (it is in GLOBAL_MODELS in tenantGuard.ts):
 * one person can belong to several workspaces, so the table is deliberately not
 * tenant-scoped and the db.ts guard adds no filter to it. Membership of a
 * workspace lives in `TenantMember`. The practical consequence is the one that
 * kept being missed: `prisma.user.findUnique({ where: { id } })` proves only that
 * a human exists SOMEWHERE on the platform. It says nothing about whether that
 * human works here.
 *
 * Three assignment surfaces shipped with exactly that mistake — Contact.ownerId
 * was persisted straight off the form with no lookup at all, CustomerCase
 * assignment checked only that the User row existed, and JobCard technician
 * assignment stored the posted id after authorising the job card but never the
 * person. A server action is reachable by POST without ever loading the page that
 * renders its form, so the dropdown is not a control: anyone able to submit the
 * form could name a stranger from another workspace and have that name persisted
 * onto this workspace's record, then rendered back on the record, in its audit
 * trail, and in the notifications the record sends.
 *
 * This module holds the DECISION, deliberately free of Prisma and of
 * `server-only`, so a test can execute the real rule instead of matching source
 * text — a rule checked by regex is pinned, not tested, and will pass happily
 * while the behaviour it describes rots. The database half (resolving an id
 * through `TenantMember`) lives in tenantActor.ts, which is `server-only` and
 * cannot be imported outside Next's bundler; `resolveAssignableUser` there is the
 * single entry point every action should call. Same split, and same reason, as
 * actionFailure.ts vs actionResult.ts.
 */

// actionFailure.ts is likewise free of `server-only` and of Prisma, so importing
// the refusal type keeps this module executable by a test while letting the
// contract throw the very thing every action already throws.
import { ActionRefusal } from "./actionFailure";

/**
 * The result of looking an id up through tenant membership: the member, or null
 * when the id resolved to nobody who works in the current workspace.
 */
export type AssignableCandidate = { id: string; name: string } | null;

/**
 * Accept with a validated id (or a deliberate `null` for "unassigned"), or refuse
 * with a sentence that is safe to show the person who submitted the form.
 *
 * A refusal is a VALUE rather than a silently dropped assignment on purpose. The
 * tempting fix for an id that does not resolve is to coerce it to null and save
 * the record anyway, which turns an attempted cross-tenant assignment and an
 * honest "leave this unassigned" into the same outcome and tells the user their
 * save worked. It also hides the attempt from whoever reads the audit trail
 * later. Refusing says what happened.
 */
export type AssignmentOutcome =
  | { ok: true; userId: string | null }
  | { ok: false; message: string };

/**
 * What the form actually submitted. An absent field and an empty selection both
 * mean "nobody", which every one of these pickers offers as its first option.
 */
export function normalizeAssigneeId(raw: unknown): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  return trimmed === "" ? null : trimmed;
}

/** The sentence a refused assignment produces. One wording for all three fields. */
export function assignmentRefusalMessage(label: string): string {
  return `That ${label} is not an active member of this workspace.`;
}

/**
 * The rule itself, given the posted value and whatever the membership lookup
 * returned.
 *
 * Blank means unassign, which is always allowed. Anything else must have come
 * back from the lookup, AND must be the very id that was posted — the second
 * half matters because a lookup helper that ever fell back to "some user" would
 * otherwise satisfy the first half while assigning the wrong person entirely.
 */
export function decideAssignment(
  raw: unknown,
  candidate: AssignableCandidate,
  label: string,
): AssignmentOutcome {
  const userId = normalizeAssigneeId(raw);
  if (userId === null) return { ok: true, userId: null };
  if (candidate === null || candidate.id !== userId) {
    return { ok: false, message: assignmentRefusalMessage(label) };
  }
  return { ok: true, userId: candidate.id };
}

/**
 * How an id is turned into a person: the TenantMember join, or a test's stand-in.
 *
 * Generic in what the lookup returns so the caller keeps whatever the join gave
 * it — `resolveTenantMemberUser` hands back an email as well, and actions use it.
 * Narrowing everything to `{ id, name }` here would push every caller into a
 * second lookup for the rest of the record, which is how "resolved" and "written"
 * drift apart.
 */
export type MembershipLookup<T extends { id: string; name: string }> = (
  userId: string,
) => Promise<T | null>;

/**
 * The WHOLE contract — normalise, look up, decide, refuse — with the database
 * passed in.
 *
 * This composition used to live in tenantActor.ts, on the far side of
 * `server-only`, which meant the one thing every caller depends on ("a bad id
 * THROWS; it does not come back as null") could only be checked by grepping the
 * source for the word `throw`. That is the failure mode this module was split
 * out to avoid: the tempting regression — swallow the refusal and return null,
 * so an attempted cross-tenant assignment and a deliberate "Unassigned" become
 * the same save — leaves the lookup call, the rule call and every call site
 * looking exactly right. Only running it tells you.
 *
 * So the lookup is a parameter. tenantActor supplies the real TenantMember join;
 * a test supplies a fake one and executes the same code the actions run.
 *
 * Returns the member, or null for a deliberately blank selection. Throws
 * {@link ActionRefusal} for anything else that does not resolve.
 */
export async function resolveAssignment<T extends { id: string; name: string }>(
  raw: unknown,
  label: string,
  lookup: MembershipLookup<T>,
): Promise<T | null> {
  // Both halves read the posted value through the SAME normaliser, so what gets
  // looked up is always exactly what the rule then judges — a second, private
  // notion of "blank" here is how the two would drift apart.
  const userId = normalizeAssigneeId(raw);
  const candidate = userId === null ? null : await lookup(userId);
  const outcome = decideAssignment(raw, candidate, label);
  if (!outcome.ok) throw new ActionRefusal(outcome.message);
  return outcome.userId === null ? null : candidate;
}

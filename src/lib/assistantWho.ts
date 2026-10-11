/**
 * WHO did it — what the assistant is told about the author of a record.
 *
 * It used to be told nothing: a lead's messages came with a date, a direction, a
 * channel and their text, so asked "who called Lisa?" it could only guess, and it
 * guessed the person asking (Sean, 2026-10-11: "DAX must have access to who
 * created records … Donovan logged this note and DAX should know that").
 *
 * The obvious fix — hand over the name on the row — is wrong in one case, and it
 * is the commonest name of all. A row needs a user, and anything with no person
 * behind it (a chatbot reply, a journey step, a customer's own message, a note
 * from the customer portal) is filed under the workspace's STAND-IN account:
 * its oldest active member, which is normally the owner. So a row under that
 * account was written by the owner OR by nobody, and the database does not say
 * which. Reporting it as the owner's would make the assistant state, confidently
 * and often, the very thing it was just corrected for.
 *
 * So:
 *  - a row under anyone else's account was written by them — said plainly;
 *  - a row under the stand-in account is said to be that person OR automatic, and
 *    the assistant is told to pass the doubt on rather than resolve it;
 *  - WHEN THE STAND-IN IS NOT KNOWN — the lookup failed, or found nobody — every
 *    name is given with that same doubt. "Could not check" is not "checked and
 *    it was a person": treating it so would quietly bring the false certainty
 *    back on exactly the day something else is already going wrong.
 *
 * Pure: no database, so the rule can be tested on its own.
 */

export type Who = { id: string; name: string | null } | null | undefined;

/** How an uncertain author is written. One phrase, so the legend can name it exactly. */
export const OR_AUTOMATIC = "or an automatic entry";

/**
 * The author of a record, as the assistant may repeat it — or null when there
 * is none to give. `standInId`: the account automated entries are filed under,
 * or null/undefined when that could not be established.
 */
export function whoLogged(person: Who, standInId: string | null | undefined): string | null {
  const name = person?.name?.trim();
  if (!person || !name) return null;
  // Certain only when the stand-in is KNOWN and this is somebody else.
  return standInId && person.id !== standInId ? name : `${name} ${OR_AUTOMATIC}`;
}

/**
 * Entries only a person makes: nobody's phone call, meeting or note arrives by
 * itself. An INBOUND one of these is a member of staff recording that the
 * customer rang or came in — the customer is who it came from, and the staff
 * member is who logged it. (Log a call / email / note, on a lead or a customer.)
 */
const LOGGED_BY_HAND: ReadonlySet<string> = new Set(["call", "meeting", "note"]);

/**
 * Who a message on a timeline is from, and who put it there.
 *
 * `from` is whose words they are; `loggedBy` is who recorded them. They differ
 * for an incoming call a member of staff logged, and treating every inbound
 * entry as "the customer wrote it, nobody logged it" lost that person.
 *
 * An inbound CHANNEL message (WhatsApp, email, a social DM) is the hard one. It
 * normally arrives by itself and is filed under the stand-in account — so under
 * that account, or with the stand-in unknown, nothing is claimed about who
 * logged it. Under any OTHER account, a person typed it in by hand, and is named.
 */
export function messageAuthor(
  message: { direction: string | null; type: string; user: Who },
  standInId: string | null | undefined,
): { from: "customer" | "us"; loggedBy: string | null } {
  if (message.direction !== "inbound") return { from: "us", loggedBy: whoLogged(message.user, standInId) };
  if (LOGGED_BY_HAND.has(message.type)) return { from: "customer", loggedBy: whoLogged(message.user, standInId) };
  const byHand = Boolean(standInId) && Boolean(message.user) && message.user!.id !== standInId;
  return { from: "customer", loggedBy: byHand ? whoLogged(message.user, standInId) : null };
}

/** Sent with the records, so the rule sits next to the data it governs. */
export const WHO_LEGEND =
  `loggedBy / scheduledBy / createdBy say WHO did it — use them, and never guess a person from the wording of a note. "from" is whose words they are: "from: customer" with a loggedBy means the customer rang or wrote and that member of staff recorded it; "from: customer" with no loggedBy arrived by itself. A name followed by "${OR_AUTOMATIC}" is NOT certain: automated messages (the chatbot, follow-up sequences, the customer portal) are filed under an account too, so say it was logged under that name and may have been automatic. Never say the person asking did something unless one of these fields names them. Where there is no such field, the CRM does not record who did it — say so.`;

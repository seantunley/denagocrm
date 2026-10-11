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
 *  - a customer's own message has no staff author at all;
 *  - a row under anyone else's account was written by them — said plainly;
 *  - a row under the stand-in account is said to be that person OR automatic, and
 *    the assistant is told to pass the doubt on rather than resolve it.
 *
 * Pure: no database, so the rule can be tested on its own.
 */

export type Who = { id: string; name: string | null } | null | undefined;

/** How an uncertain author is written. One phrase, so the legend can name it exactly. */
export const OR_AUTOMATIC = "or an automatic entry";

/**
 * The author of a record, as the assistant may repeat it — or null when there
 * is none to give. `standInId`: the account automated entries are filed under.
 */
export function whoLogged(person: Who, standInId: string | null | undefined): string | null {
  const name = person?.name?.trim();
  if (!person || !name) return null;
  return standInId && person.id === standInId ? `${name} ${OR_AUTOMATIC}` : name;
}

/** Sent with the records, so the rule sits next to the data it governs. */
export const WHO_LEGEND =
  `loggedBy / scheduledBy / createdBy say WHO did it — use them, and never guess a person from the wording of a note. "from: customer" means the customer wrote it. A name followed by "${OR_AUTOMATIC}" is NOT certain: automated messages (the chatbot, follow-up sequences, the customer portal) are filed under that account too, so say it was logged under that name and may have been automatic. Never say the person asking did something unless one of these fields names them. Where there is no such field, the CRM does not record who did it — say so.`;

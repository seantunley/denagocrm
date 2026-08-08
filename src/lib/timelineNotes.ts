/**
 * A lead note that IS the contact's note is one note, not two.
 *
 * Two correct changes collided. Carrying the lead's notes onto the contact it
 * becomes (actions/leads.ts) is right — otherwise the note vanishes on
 * conversion. Surfacing every linked lead's notes on the contact timeline is also
 * right — otherwise a `lead_note` pin exists with nothing to render on. Together
 * they showed the same sentence twice for every converted lead:
 *
 *   Original contact note
 *   "Wants the Rover XL, needs finance"
 *
 *   Original lead note — Rover XL enquiry
 *   "Wants the Rover XL, needs finance"
 *
 * THE FIRST FIX COMPARED THE TEXT, AND THAT WAS WRONG. Review put it exactly:
 * text equality is not provenance. An existing customer whose own note happens to
 * read the same as a later, unrelated lead's note has TWO genuine CRM events, and
 * comparing sentences silently deletes one of them from the history. A timeline is
 * a record of what happened; it should not decide two things are one because they
 * are worded alike.
 *
 * So the copy is RECORDED at the moment it is made. `Contact.notesFromLeadId`
 * names the lead whose notes were copied, set by all three conversion paths, and
 * this filter drops that lead's note and no other. Identical text on a different
 * lead is now untouched, because it is a different event and always was.
 *
 * Pure, so every case is testable without a contact page.
 */

export type TimelineLeadNote = {
  leadId: string;
  title: string;
  text: string;
  when: Date;
  who: string;
};

/**
 * The lead notes worth showing beside a contact's own note.
 *
 * `notesFromLeadId` is null for a contact that was not created from a lead, and
 * for one converted before the column existed — the migration backfills what it
 * can identify unambiguously and leaves the rest null. Null shows BOTH entries,
 * which is the safe direction: a duplicate is visible and can be judged, whereas
 * a note this function hides is gone with no trace that it existed.
 */
export function distinctLeadNotes<T extends { leadId: string }>(
  leadNotes: T[],
  notesFromLeadId: string | null | undefined,
): T[] {
  if (!notesFromLeadId) return leadNotes;
  return leadNotes.filter((note) => note.leadId !== notesFromLeadId);
}

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
 * Compared by TEXT rather than by tracking provenance. The copy is verbatim, so
 * the text already answers the question; a `copiedFromLeadId` column would be a
 * schema change to record something we can already see. Whitespace is normalised
 * because the value came through a form.
 *
 * Pure, so both cases can be tested without a contact page: the converted lead
 * whose note must appear ONCE, and the pre-existing contact whose own note and a
 * linked lead's different note must BOTH appear.
 */

export type TimelineLeadNote = {
  leadId: string;
  title: string;
  text: string;
  when: Date;
  who: string;
};

/** Trim, and collapse any run of whitespace, so formatting is not identity. */
function normalise(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * The lead notes worth showing beside a contact's own note.
 *
 * With no contact note, every lead note is distinct by definition — that is the
 * lead's own timeline, and filtering there would hide the note entirely.
 */
export function distinctLeadNotes<T extends { text: string }>(
  leadNotes: T[],
  creationNote: { text: string } | null | undefined,
): T[] {
  if (!creationNote) return leadNotes;
  const contactNote = normalise(creationNote.text);
  return leadNotes.filter((note) => normalise(note.text) !== contactNote);
}

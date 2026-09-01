/**
 * One way to decide whether two written phone numbers are the same number.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * CRM phone fields are free-form, and inbound channels hand us digits. Three
 * different lookups each invented their own comparison:
 *
 *   * `matchByPhone` used `endsWith` on the last 9 characters — which needs a
 *     CONTIGUOUS digit run, so a contact stored as "082 123 4567" never matched
 *     the same person messaging from +27821234567;
 *   * `ensureContact`, which every chatbot action calls before booking anything,
 *     used EXACT STRING EQUALITY — so a customer typing 0821234567 for a contact
 *     stored as +27821234567 got a brand-new duplicate Contact;
 *   * the survey/campaign audiences just checked the field was non-empty.
 *
 * The visible symptom is duplicates: a customer the CRM already knows arrives as
 * a stranger, and the second record accumulates its own history. Nothing fails
 * loudly, so the two records simply drift apart.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 * Compare the last {@link TAIL_LENGTH} digits, after removing everything that is
 * not a digit. That is enough to identify a subscriber number across the ways
 * people write it — `+27 82 123 4567`, `082 123 4567`, `27821234567`,
 * `(082) 123-4567` all reduce to the same tail — without needing to know the
 * country, which we cannot reliably infer from a free-text field.
 *
 * It is deliberately NOT full E.164 parsing. That would need a country for every
 * stored value, and guessing one wrongly merges two different people, which is
 * far worse than failing to merge one person.
 *
 * ── WHY THE SQL LIVES HERE TOO ──────────────────────────────────────────────
 *
 * {@link PHONE_TAIL_SQL} is the same rule expressed for Postgres, and it is
 * exported rather than written out at each call site for one specific reason:
 * migration 82 builds an EXPRESSION INDEX on exactly this text. If a query and
 * the index expression ever drift by so much as a character, Postgres silently
 * stops using the index and the lookup degrades to a sequential scan of every
 * contact in the install. Sharing the string is what makes that impossible, and
 * `tests/phoneMatch.test.ts` asserts the migration contains it verbatim.
 */

/**
 * How many trailing digits identify a subscriber.
 *
 * Nine is the South African subscriber number without its trunk 0 (821234567),
 * and it is what the previous `endsWith` implementation used — so this changes
 * HOW reliably numbers match, not WHICH numbers are considered the same.
 */
export const TAIL_LENGTH = 9;

/** Everything that is not a digit, removed. `+27 82 123-4567` → `27821234567`. */
export function onlyDigits(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\D/g, "");
}

/**
 * The comparable tail, or null when there are not enough digits to identify
 * anyone.
 *
 * Null is important: a field holding "n/a", an extension like "x204", or four
 * stray digits must match NOBODY rather than match everybody with those digits
 * at the end.
 */
export function phoneTail(raw: string | null | undefined): string | null {
  const digits = onlyDigits(raw);
  if (digits.length < TAIL_LENGTH) return null;
  return digits.slice(-TAIL_LENGTH);
}

/** Whether two written numbers denote the same subscriber. */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = phoneTail(a);
  const right = phoneTail(b);
  return left !== null && left === right;
}

/**
 * The identical rule in SQL, as a template for one column.
 *
 * `coalesce` first so a NULL column yields '' rather than NULL — a NULL tail
 * would make every comparison NULL (not false), and `NOT (NULL)` is not true,
 * which is exactly the kind of three-valued-logic surprise that makes a
 * predicate quietly match nothing.
 *
 * MUST match migration 82's index expression character for character.
 */
export function PHONE_TAIL_SQL(column: string): string {
  return `right(regexp_replace(coalesce(${column}, ''), '[^0-9]', '', 'g'), ${TAIL_LENGTH})`;
}

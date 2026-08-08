/**
 * The label for a lead in a picker.
 *
 * THE BUG THIS FIXES. The quote editor's "Link to a lead" dropdown built its
 * options from `lead.title || lead.name`. `title` is what the lead is FOR — the
 * vehicle or package someone is interested in — and a dealership sells the same
 * few models over and over, so every option in the list read "Denago EV Rover
 * XL". The picker was unusable: there was no way to tell which lead was which,
 * and picking the wrong one attaches a quote to another customer's record.
 *
 * `name` is the customer. That is the part that distinguishes one lead from
 * another and it was the part being thrown away whenever a title existed.
 *
 * The short id is the tie-breaker. Two open leads for the same customer and the
 * same model is not a strange case — it is a second quote for a second unit —
 * and no combination of human fields separates those. Lead has no reference or
 * number column, so the handle is derived from the cuid: the last six
 * characters, uppercased. Cuid suffixes are the random part, so a six-character
 * tail distinguishes reliably at this scale while staying short enough to read
 * out over a phone.
 */

export type LeadOptionSource = {
  id: string;
  /** The customer. */
  name?: string | null;
  /** What the lead is for — the model or package. */
  title?: string | null;
};

/** A short, stable, readable handle for a lead id. */
export function shortLeadRef(id: string): string {
  const trimmed = (id ?? "").trim();
  if (!trimmed) return "";
  return trimmed.slice(-6).toUpperCase();
}

/**
 * `Customer — Interest · ABC123`
 *
 * Every part is optional except the reference, so a lead missing its name or
 * title still produces something selectable rather than an empty option the user
 * cannot even see to click.
 */
export function leadOptionLabel(lead: LeadOptionSource): string {
  const customer = (lead.name ?? "").trim();
  const interest = (lead.title ?? "").trim();
  const ref = shortLeadRef(lead.id);

  // Customer first: it is what the user is looking for, and a long interest
  // string must not push it out of view in a narrow select.
  const head = [customer, interest].filter(Boolean).join(" — ");
  if (!head) return ref || "Untitled lead";
  return ref ? `${head} · ${ref}` : head;
}

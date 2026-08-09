/**
 * Labels for a list of leads in a picker.
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
 * ── WHY THIS IS A LIST FUNCTION, NOT A LABEL FUNCTION ───────────────────────
 *
 * The first version derived a reference from the last six characters of the cuid
 * and called that the tie-breaker. It is not one. Two ids ending in the same six
 * characters produce the same label again, and the whole point of the reference
 * is that picking the wrong lead is a real consequence — so "probably unique" is
 * the wrong standard for it.
 *
 * Uniqueness is a property of the LIST, not of any one lead, so the list is what
 * gets labelled. `leadOptionLabels` lengthens the reference only as far as it has
 * to: six characters while that separates everything on offer, more for the ids
 * that actually collide, up to the full id if it comes to that. Nobody reads a
 * longer reference than the situation requires, and the guarantee is absolute
 * rather than probabilistic.
 */

export type LeadOptionSource = {
  id: string;
  /** The customer. */
  name?: string | null;
  /** What the lead is for — the model or package. */
  title?: string | null;
};

export type LeadOption<T extends LeadOptionSource> = T & { label: string };

/** Where the reference starts before collisions force it longer. */
const BASE_REF_LENGTH = 6;

/** A short, stable, readable handle for a lead id. */
export function shortLeadRef(id: string, length = BASE_REF_LENGTH): string {
  const trimmed = (id ?? "").trim();
  if (!trimmed) return "";
  return trimmed.slice(-Math.max(1, length)).toUpperCase();
}

/** `Customer — Interest`, without the reference. */
function describe(lead: LeadOptionSource): string {
  const customer = (lead.name ?? "").trim();
  const interest = (lead.title ?? "").trim();
  // Customer first: it is what the user is looking for, and a long interest
  // string must not push it out of view in a narrow select.
  return [customer, interest].filter(Boolean).join(" — ");
}

/**
 * The shortest reference length at which every id in the list is distinct.
 *
 * Grows one character at a time from the base rather than jumping to the full
 * id, so the common case — no collisions at all — still reads as a short handle.
 */
function refLengthFor(ids: readonly string[]): number {
  const longest = ids.reduce((max, id) => Math.max(max, id.trim().length), 0);
  for (let length = BASE_REF_LENGTH; length < longest; length++) {
    const refs = ids.map((id) => shortLeadRef(id, length));
    if (new Set(refs).size === ids.length) return length;
  }
  // Either the full id is needed, or two entries share an id — which is not
  // something a longer reference can fix, and not something this should hide.
  return longest;
}

/**
 * Label every lead in a list, guaranteeing no two options read the same.
 *
 * A label is `Customer — Interest · ABC123`. The reference is omitted when the
 * description alone is already unique across the list, because a reference on
 * every option is noise when nothing is ambiguous — and shown, at whatever
 * length it takes, the moment two options would otherwise be indistinguishable.
 */
export function leadOptionLabels<T extends LeadOptionSource>(leads: readonly T[]): LeadOption<T>[] {
  const descriptions = leads.map(describe);
  const collides = new Set(
    descriptions.filter((value, index) => descriptions.indexOf(value) !== index),
  );

  const refLength = refLengthFor(leads.map((lead) => lead.id));

  return leads.map((lead, index) => {
    const description = descriptions[index];
    const ref = shortLeadRef(lead.id, refLength);
    // No description at all: the reference is the only thing left to show, and a
    // blank option cannot even be clicked to find out what it is.
    if (!description) return { ...lead, label: ref || "Untitled lead" };
    // Unambiguous on its own — leave it clean.
    if (!collides.has(description)) return { ...lead, label: description };
    return { ...lead, label: ref ? `${description} · ${ref}` : description };
  });
}

/**
 * A single lead's label, for the rare caller with no list around it.
 *
 * Always carries the reference: with nothing to compare against there is no way
 * to know whether the description alone would be ambiguous, and the safe answer
 * when picking wrong costs something is to show the handle.
 */
export function leadOptionLabel(lead: LeadOptionSource): string {
  const description = describe(lead);
  const ref = shortLeadRef(lead.id);
  if (!description) return ref || "Untitled lead";
  return ref ? `${description} · ${ref}` : description;
}

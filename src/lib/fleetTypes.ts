/**
 * The account types a fleet can be — the SINGLE source of truth.
 *
 * This list previously lived in `app/(app)/fleets/page.tsx` and the fleet detail
 * page imported it from there, which is why an option could go missing: a page
 * module is not where a shared constant belongs, and a page may only export the
 * handful of names Next.js recognises (`default`, `dynamic`, `generateMetadata`,
 * …), so anything else riding along is one build-time export check away from
 * breaking. Both `<select>`s now render from HERE and cannot drift apart.
 *
 * Values are stored verbatim in `Fleet.type` (a plain nullable string, not an
 * enum), so ADDING an entry is additive and needs no migration — but never
 * RENAME one without a data fix, or existing rows stop matching their option.
 */
export const FLEET_TYPES = ["estate", "golf-course", "lodge", "resort", "business", "other"] as const;

export type FleetType = (typeof FLEET_TYPES)[number];

/**
 * How each stored value is written for a person to read. The stored value is a
 * slug, and "golf-course" in a dropdown and on a status pill is the machine's
 * spelling leaking into the product.
 */
export const FLEET_TYPE_LABELS: Record<FleetType, string> = {
  estate: "Estate",
  "golf-course": "Golf course",
  lodge: "Lodge",
  resort: "Resort",
  business: "Business",
  other: "Other",
};

/**
 * Label for a stored value, INCLUDING one that is no longer offered. `Fleet.type`
 * is a free string column, so a row can hold a value this list has never had
 * (an import, or an option removed later); showing the raw value beats showing
 * nothing.
 */
export function fleetTypeLabel(type: string | null | undefined): string | null {
  if (!type) return null;
  return FLEET_TYPE_LABELS[type as FleetType] ?? type;
}

/** What a new fleet is assumed to be until someone says otherwise. */
export const DEFAULT_FLEET_TYPE: FleetType = "estate";

/**
 * The type as SUBMITTED, or null if it is not one we offer.
 *
 * `Fleet.type` is a free string column, so without this a POST straight at the
 * server action stores whatever it likes — and the value is rendered back onto
 * the fleets list and the detail header. Refusing to a null "not set" rather than
 * silently substituting the default: an unrecognised type is a caller error, and
 * quietly recording an estate because someone sent nonsense is a lie about the
 * record. Blank is legitimately "not set" and takes the same path.
 *
 * Note this validates the WRITE side only. `fleetTypeLabel` still renders values
 * outside the list, because rows written before an option was renamed or removed
 * are real and must not display as blank.
 */
export function parseFleetType(value: unknown): FleetType | null {
  const raw = String(value ?? "").trim();
  return FLEET_TYPES.includes(raw as FleetType) ? (raw as FleetType) : null;
}

/** One fleet as a pickable option. */
export type FleetOption = { id: string; name: string };

/**
 * What a contact form may offer in its "Fleet" dropdown.
 *
 * `canLink` and `fleets` answer separate questions, and collapsing them into a
 * bare array loses the difference between "you may not see fleet accounts" and
 * "there are no fleet accounts yet" — which need opposite things said to them
 * ("ask an administrator" vs "create one first").
 *
 * The shape lives in this pure module, not next to the query that produces it
 * (lib/fleetDirectory.ts), because the CLIENT component that renders the dropdown
 * needs the type and that module is `server-only`.
 */
export type FleetPicker = { canLink: boolean; fleets: FleetOption[] };

/** Nobody may link a fleet, and nothing was read to find that out. */
export const NO_FLEET_PICKER: FleetPicker = { canLink: false, fleets: [] };

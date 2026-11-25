/**
 * Which record the contextual drawer has open (wave 2, W2-01), carried in the URL
 * as `?open=<type>:<id>` so a list keeps its filters, sort, page and scroll, a
 * link can be shared, and Back closes the drawer. Pure — no React, no database.
 *
 * The id is only a reference. The server re-checks the workspace and the person's
 * access on every load; a well-formed ref grants nothing.
 */

export const RECORD_TYPES = ["lead"] as const;
export type RecordType = (typeof RECORD_TYPES)[number];
export type RecordRef = { type: RecordType; id: string };

export const OPEN_PARAM = "open";

/** cuid-style ids: letters and digits only, so a ref can never smuggle a path or a query. */
const ID = /^[A-Za-z0-9_-]{6,64}$/;

export function parseRecordRef(raw: string | null | undefined): RecordRef | null {
  if (!raw) return null;
  const at = raw.indexOf(":");
  if (at < 1) return null;
  const type = raw.slice(0, at);
  const id = raw.slice(at + 1);
  if (!(RECORD_TYPES as readonly string[]).includes(type) || !ID.test(id)) return null;
  return { type: type as RecordType, id };
}

export const formatRecordRef = (ref: RecordRef) => `${ref.type}:${ref.id}`;

/** The full page for a record — always offered, for anything the drawer does not do. */
export function fullRecordHref(ref: RecordRef): string {
  switch (ref.type) {
    case "lead":
      return `/leads/${ref.id}`;
  }
}

/**
 * The current URL with the drawer opened on `ref` (or closed, for null). Every other
 * search param — filters, the search box, `?page=`, `?view=` — is kept as it is.
 */
export function withOpenRecord(search: string, ref: RecordRef | null): string {
  const params = new URLSearchParams(search);
  if (ref) params.set(OPEN_PARAM, formatRecordRef(ref));
  else params.delete(OPEN_PARAM);
  const query = params.toString();
  return query ? `?${query}` : "";
}

/**
 * The record before or after `current` in the list as the person sees it, by the
 * order of the rows on screen — so "Next" follows the list's own sort and filters.
 */
export function neighbour(order: string[], current: string, step: 1 | -1): string | null {
  const at = order.indexOf(current);
  if (at === -1) return order[0] ?? null;
  return order[at + step] ?? null;
}

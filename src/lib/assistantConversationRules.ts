/** The pure half of assistantConversation.ts — no server imports, so tests can run it. */

/** A title's length, typed or automatic. */
export const TITLE_MAX = 70;
/** A deleted conversation can be restored this long; then the nightly purge removes it (trash.ts, same window). */
export const TRASH_DAYS = 60;

/** A clean title as typed: whitespace collapsed, capped like the automatic ones. Empty = not a title. */
export function cleanTitle(typed: unknown): string {
  const t = String(typed ?? "").replace(/\s+/g, " ").trim();
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1).trimEnd()}…` : t;
}

/** A short piece of `text` around the first place it says `query` (any case), for a search result. */
export function snippet(text: string, query: string, radius = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return flat.length > radius * 2 ? `${flat.slice(0, radius * 2).trimEnd()}…` : flat;
  const start = Math.max(0, at - radius);
  const end = Math.min(flat.length, at + query.length + radius);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

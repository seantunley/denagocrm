/**
 * Server-side paging for the main list pages (quotes, contacts, leads, job cards).
 *
 * These lists used to load "the newest 200" and filter that in memory, so a
 * search could never find row 201 and nobody could see past it. Now the filter
 * runs in the database and the page is a window over the full result, carried in
 * the URL (`?page=`) so back, refresh and shared links keep it.
 *
 * Pure on purpose — no database, no React — so it is unit-tested directly.
 */

export const PAGE_SIZE = 50;

export type ListSearchParams = Record<string, string | string[] | undefined>;

/** `?page=` as a 1-based page number. Anything unusable is page 1. */
export function parsePage(raw: string | string[] | undefined): number {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isSafeInteger(n) && n > 1 ? n : 1;
}

/**
 * The window to fetch, clamped to the last page that has rows — deleting the
 * only row on the last page must not strand the user on an empty page.
 */
export function pageWindow(requested: number, total: number, size = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(Math.max(1, requested), pages);
  return { page, pages, skip: (page - 1) * size, take: size };
}

/**
 * The link to another page. Keeps EVERY other search param — filters, the
 * search box, `?view=`, and `?edit=` on quotes, which opens the editor — and
 * only replaces `page`. Page 1 drops the param so the canonical URL stays clean.
 */
export function pageHref(path: string, params: ListSearchParams | URLSearchParams, page: number): string {
  const query = new URLSearchParams();
  const entries = params instanceof URLSearchParams ? params.entries() : Object.entries(params);
  for (const [key, value] of entries) {
    if (key === "page" || value == null) continue;
    for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
  }
  if (page > 1) query.set("page", String(page));
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * A search box split into terms. Every term must match somewhere, so
 * "Thandi Mokoena" finds a first name + last name that no single column holds.
 * Capped so a pasted paragraph cannot become a 200-clause query.
 */
export function searchTerms(q: string | null | undefined): string[] {
  return (q ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 6);
}

/** Prisma's case-insensitive substring match. */
export const containsText = (term: string) => ({ contains: term, mode: "insensitive" as const });

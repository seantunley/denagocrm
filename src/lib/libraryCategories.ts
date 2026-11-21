/**
 * The Library's categories (Sean, 2026-11-21: "How do I label brochures? Price lists?"). The workspace's own list,
 * edited on the Library — a dropdown, never free text — and every save checked against it. Pure.
 */

export const LIBRARY_CATEGORIES_KEY = "LIBRARY_CATEGORIES";
export const DEFAULT_LIBRARY_CATEGORIES: readonly string[] = ["Brochure", "Price list", "Spec sheet", "Warranty", "Other"];
const CATEGORY_MAX = 40;
const CATEGORIES_MAX = 30;

const tidy = (raw: string) => raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, CATEGORY_MAX).trim();

/** The saved setting (one per line) → the list offered; blank or never set → the defaults. Repeats (any case) dropped. */
export function parseLibraryCategories(raw: string | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of String(raw ?? "").split("\n")) {
    const category = tidy(line);
    if (category && !seen.has(category.toLowerCase())) {
      seen.add(category.toLowerCase());
      out.push(category);
    }
  }
  return out.length ? out.slice(0, CATEGORIES_MAX) : [...DEFAULT_LIBRARY_CATEGORIES];
}

/**
 * What was posted, as it is on the list (exactly as listed, whatever case was sent), or not ok. "" means no category.
 * An item's existing category that has since left the list may be kept as itself.
 */
export function chosenLibraryCategory(
  posted: unknown,
  categories: readonly string[],
  current?: string | null,
): { ok: true; category: string | null } | { ok: false } {
  const value = tidy(String(posted ?? ""));
  if (!value) return { ok: true, category: null };
  const match = categories.find((c) => c.toLowerCase() === value.toLowerCase());
  if (match) return { ok: true, category: match };
  if (current && current.toLowerCase() === value.toLowerCase()) return { ok: true, category: current };
  return { ok: false };
}

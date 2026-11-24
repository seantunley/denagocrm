/**
 * Ranking for the help centre's front-page search (components/help/HelpSearch.tsx).
 * Pure. A word in the title counts for most; a word in the summary or keywords
 * counts; every word typed must be found somewhere, so adding a word narrows
 * the results rather than widening them.
 */
export type QuickSearchEntry = { slug: string; title: string; summary: string; keywords: readonly string[] };

export function rankHelp<T extends QuickSearchEntry>(entries: readonly T[], query: string, limit = 8): T[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const scored: { entry: T; score: number }[] = [];
  for (const entry of entries) {
    const title = entry.title.toLowerCase();
    const rest = `${entry.summary} ${entry.keywords.join(" ")}`.toLowerCase();
    let score = 0;
    let all = true;
    for (const term of terms) {
      const inTitle = title.includes(term);
      const inRest = rest.includes(term);
      if (!inTitle && !inRest) { all = false; break; }
      score += (inTitle ? 6 : 0) + (inRest ? 2 : 0);
    }
    if (all) scored.push({ entry, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title)).slice(0, limit).map((item) => item.entry);
}

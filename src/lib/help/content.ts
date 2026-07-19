import type { HelpArticle, HelpCategoryKey } from "./types";
import { HELP_CATEGORIES } from "./categories";
import { gettingStartedArticles } from "./articles/getting-started";
import crm from "./data/crm.json";
import sales from "./data/sales.json";
import stock from "./data/stock.json";
import workshop from "./data/workshop.json";
import documents from "./data/documents.json";
import marketing from "./data/marketing.json";
import commsAutomation from "./data/comms-automation.json";
import admin from "./data/admin.json";

// Single source of truth for the Help Centre and the printable manual. Getting
// Started is hand-authored; the rest is assembled per module from typed JSON.
export const HELP_ARTICLES: HelpArticle[] = [
  ...gettingStartedArticles,
  ...(crm as HelpArticle[]),
  ...(sales as HelpArticle[]),
  ...(stock as HelpArticle[]),
  ...(workshop as HelpArticle[]),
  ...(documents as HelpArticle[]),
  ...(marketing as HelpArticle[]),
  ...(commsAutomation as HelpArticle[]),
  ...(admin as HelpArticle[]),
];

const BY_SLUG = new Map(HELP_ARTICLES.map((a) => [a.slug, a]));

export function getArticle(slug: string): HelpArticle | undefined {
  return BY_SLUG.get(slug);
}

export function articlesInCategory(key: HelpCategoryKey): HelpArticle[] {
  return HELP_ARTICLES.filter((a) => a.category === key);
}

/** Categories that actually have articles, in display order, with their articles attached. */
export function categoriesWithArticles(): { key: HelpCategoryKey; label: string; description: string; icon: string; articles: HelpArticle[] }[] {
  return HELP_CATEGORIES.map((c) => ({ ...c, articles: articlesInCategory(c.key) })).filter((c) => c.articles.length > 0);
}

/** Lightweight relevance search over title, summary, keywords and body text. */
export function searchArticles(query: string): HelpArticle[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  const scored: { a: HelpArticle; score: number }[] = [];
  for (const a of HELP_ARTICLES) {
    const haystackStrong = `${a.title} ${a.summary} ${a.keywords.join(" ")}`.toLowerCase();
    const bodyText = a.body
      .map((b) => ("text" in b ? b.text : "items" in b ? b.items.join(" ") : "headers" in b ? `${b.headers.join(" ")} ${b.rows.flat().join(" ")}` : ""))
      .join(" ")
      .toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (a.title.toLowerCase().includes(t)) score += 6;
      if (haystackStrong.includes(t)) score += 3;
      if (bodyText.includes(t)) score += 1;
    }
    if (score > 0) scored.push({ a, score });
  }
  return scored.sort((x, y) => y.score - x.score).map((s) => s.a);
}

/** Compact index for the client-side search box (no heavy body payload). */
export type HelpSearchEntry = { slug: string; title: string; summary: string; category: HelpCategoryKey; keywords: string[] };
export const HELP_SEARCH_INDEX: HelpSearchEntry[] = HELP_ARTICLES.map((a) => ({
  slug: a.slug,
  title: a.title,
  summary: a.summary,
  category: a.category,
  keywords: a.keywords,
}));

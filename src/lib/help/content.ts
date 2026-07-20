import type { HelpArticle, HelpCategoryKey } from "./types";
import type { ModuleId } from "@/lib/modules/registry";
import { isArticleEnabled } from "./modules";
import { HELP_CATEGORIES } from "./categories";
import { gettingStartedArticles } from "./articles/getting-started";
import crm from "./data/crm.json";
import sales from "./data/sales.json";
import stock from "./data/stock.json";
import workshop from "./data/workshop.json";
import documents from "./data/documents.json";
import marketing from "./data/marketing.json";
import commsAutomation from "./data/comms-automation.json";
import channels from "./data/channels.json";
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
  ...(channels as HelpArticle[]),
  ...(admin as HelpArticle[]),
];

const BY_SLUG = new Map(HELP_ARTICLES.map((a) => [a.slug, a]));

export function getArticle(slug: string): HelpArticle | undefined {
  return BY_SLUG.get(slug);
}

// When an `enabled` module set is passed, articles owned by a disabled pack are
// dropped (core is always kept); omitting it returns every article unchanged, so
// existing callers and tests are behaviour-preserving.
function visibleArticles(enabled?: ReadonlySet<ModuleId>): HelpArticle[] {
  if (!enabled) return HELP_ARTICLES;
  return HELP_ARTICLES.filter((a) => isArticleEnabled(a, enabled));
}

export function articlesInCategory(key: HelpCategoryKey, enabled?: ReadonlySet<ModuleId>): HelpArticle[] {
  return visibleArticles(enabled).filter((a) => a.category === key);
}

/** Categories that actually have articles, in display order, with their articles attached. */
export function categoriesWithArticles(enabled?: ReadonlySet<ModuleId>): { key: HelpCategoryKey; label: string; description: string; icon: string; articles: HelpArticle[] }[] {
  return HELP_CATEGORIES.map((c) => ({ ...c, articles: articlesInCategory(c.key, enabled) })).filter((c) => c.articles.length > 0);
}

/** Lightweight relevance search over title, summary, keywords and body text. */
export function searchArticles(query: string, enabled?: ReadonlySet<ModuleId>): HelpArticle[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  const scored: { a: HelpArticle; score: number }[] = [];
  for (const a of visibleArticles(enabled)) {
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

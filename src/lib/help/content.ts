import type { HelpArticle, HelpCategoryKey } from "./types";
import type { ModuleId } from "@/lib/modules/registry";
import { isArticleEnabled } from "./modules";
import { HELP_CATEGORIES } from "./categories";
import { gettingStartedArticles } from "./articles/getting-started";
import { dashboardArticles } from "./articles/dashboards";
import { xAndAttentionArticles } from "./articles/x-and-attention";
import { journeysArticles } from "./articles/journeys";
import crm from "./data/crm.json";
import sales from "./data/sales.json";
import stock from "./data/stock.json";
import workshop from "./data/workshop.json";
import testDrives from "./data/test-drives.json";
import documents from "./data/documents.json";
import marketing from "./data/marketing.json";
import marketingGovernance from "./data/marketing-governance.json";
import commsAutomation from "./data/comms-automation.json";
import channels from "./data/channels.json";
import admin from "./data/admin.json";

// data/marketing.json is the original generated marketing set. Where an article
// has since been re-authored by hand under the SAME slug, the generated one is
// dropped here rather than edited in place — the hand-authored file is the one
// source of truth, and a stale duplicate would silently win or lose depending on
// import order.
//
// The journey/automation entries are the second wave of this: the AutomationRule
// engine was retired and its rules converted into journeys, so the generated
// "Automations: lead workflow rules" article documented a feature that no longer
// exists. articles/journeys.ts replaces all three, keeping `automations-rules` as
// the slug that explains where automation rules went.
const REPLACED_MARKETING_SLUGS = new Set([
  "campaigns-overview",
  "campaigns-build-and-send",
  "campaigns-audiences-and-subscribers",
  "campaigns-tracking-and-analytics",
  "surveys-overview",
  "surveys-build-and-configure",
  "surveys-send-and-responses",
  "automations-rules",
  "journeys-overview",
  "journeys-build-and-publish",
]);
const preservedLegacyMarketing = (marketing as HelpArticle[]).filter((article) => !REPLACED_MARKETING_SLUGS.has(article.slug));

export const HELP_ARTICLES: HelpArticle[] = [
  ...gettingStartedArticles,
  ...dashboardArticles,
  ...xAndAttentionArticles,
  ...(crm as HelpArticle[]),
  ...(sales as HelpArticle[]),
  ...(stock as HelpArticle[]),
  ...(workshop as HelpArticle[]),
  ...(testDrives as HelpArticle[]),
  ...(documents as HelpArticle[]),
  ...preservedLegacyMarketing,
  ...(marketingGovernance as HelpArticle[]),
  ...journeysArticles,
  ...(commsAutomation as HelpArticle[]),
  ...(channels as HelpArticle[]),
  ...(admin as HelpArticle[]),
];

const BY_SLUG = new Map(HELP_ARTICLES.map((article) => [article.slug, article]));

export function getArticle(slug: string): HelpArticle | undefined {
  return BY_SLUG.get(slug);
}

function visibleArticles(enabled?: ReadonlySet<ModuleId>): HelpArticle[] {
  if (!enabled) return HELP_ARTICLES;
  return HELP_ARTICLES.filter((article) => isArticleEnabled(article, enabled));
}

export function articlesInCategory(key: HelpCategoryKey, enabled?: ReadonlySet<ModuleId>): HelpArticle[] {
  return visibleArticles(enabled).filter((article) => article.category === key);
}

export function categoriesWithArticles(enabled?: ReadonlySet<ModuleId>): { key: HelpCategoryKey; label: string; description: string; icon: string; articles: HelpArticle[] }[] {
  return HELP_CATEGORIES.map((category) => ({ ...category, articles: articlesInCategory(category.key, enabled) })).filter((category) => category.articles.length > 0);
}

export function searchArticles(query: string, enabled?: ReadonlySet<ModuleId>): HelpArticle[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const terms = normalized.split(/\s+/).filter(Boolean);
  const scored: { article: HelpArticle; score: number }[] = [];
  for (const article of visibleArticles(enabled)) {
    const strong = `${article.title} ${article.summary} ${article.keywords.join(" ")}`.toLowerCase();
    const bodyText = article.body
      .map((block) => ("text" in block ? block.text : "items" in block ? block.items.join(" ") : "headers" in block ? `${block.headers.join(" ")} ${block.rows.flat().join(" ")}` : ""))
      .join(" ")
      .toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (article.title.toLowerCase().includes(term)) score += 6;
      if (strong.includes(term)) score += 3;
      if (bodyText.includes(term)) score += 1;
    }
    if (score > 0) scored.push({ article, score });
  }
  return scored.sort((left, right) => right.score - left.score).map((result) => result.article);
}

export type HelpSearchEntry = { slug: string; title: string; summary: string; category: HelpCategoryKey; keywords: string[] };
export const HELP_SEARCH_INDEX: HelpSearchEntry[] = HELP_ARTICLES.map((article) => ({
  slug: article.slug,
  title: article.title,
  summary: article.summary,
  category: article.category,
  keywords: article.keywords,
}));

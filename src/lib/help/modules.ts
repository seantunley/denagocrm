// Which feature module each Help Centre article belongs to. This is what lets
// the Help Centre hide guides for packs an owner has switched off, mirroring the
// route-level gating in ../modules. Pure data (registry + types only, no server
// or React imports) so it runs in the app, in the print manual and in tests.
//
// Resolution order (most specific wins): exact slug override → slug prefix →
// category default → "core". Core is always shown. Article *content* is never
// touched — only whether an article is visible.

import type { ModuleId } from "@/lib/modules/registry";
import { MANDATORY_MODULE_IDS } from "@/lib/modules/registry";
import type { HelpArticle, HelpCategoryKey } from "./types";

// Base map: the module a whole category belongs to. Two categories deliberately
// mix modules and are refined per-article below:
//   • "comms"  = Social inbox (default) + Help desk (cases-/helpdesk- → support)
//   • "stock"  = Stock & inventory (default) + Automotive (stock-vehicles- → automotive)
const CATEGORY_MODULE: Record<HelpCategoryKey, ModuleId> = {
  "getting-started": "core",
  crm: "core",
  sales: "core",
  stock: "commerce",
  workshop: "automotive",
  marketing: "marketing",
  comms: "inbox",
  automation: "automation",
  documents: "core",
  governance: "core",
  admin: "core",
};

// Exact-slug overrides: articles authored under one category that actually
// document another module's feature. Route ownership decides, mirroring
// moduleForPath (e.g. /fleets, /deliveries and /referrals are not core).
const SLUG_MODULE: Record<string, ModuleId> = {
  "fleets-management": "automotive", // /fleets
  "deliveries-board": "automotive", // /deliveries
  "referrals-overview": "marketing", // /referrals
  "admin-portal-access": "portal", // customer portal access, gone if portal is off
};

// Slug-prefix overrides: whole article families that split out of a mixed
// category. Checked in order; the first matching prefix wins.
const SLUG_PREFIX_MODULE: ReadonlyArray<{ prefix: string; module: ModuleId }> = [
  { prefix: "inbox-", module: "inbox" },
  { prefix: "connect-", module: "inbox" }, // channel connections feed the social inbox
  { prefix: "cases-", module: "support" },
  { prefix: "helpdesk-", module: "support" },
  { prefix: "stock-vehicles-", module: "automotive" }, // vehicle records live in the automotive pack
];

/** The feature module that owns a help article. Unknown / general → "core". */
export function moduleForArticle(article: Pick<HelpArticle, "slug" | "category">): ModuleId {
  const exact = SLUG_MODULE[article.slug];
  if (exact) return exact;
  for (const { prefix, module } of SLUG_PREFIX_MODULE) {
    if (article.slug.startsWith(prefix)) return module;
  }
  return CATEGORY_MODULE[article.category] ?? "core";
}

/** True when the module owning an article is enabled (mandatory core always shown). */
export function isArticleEnabled(
  article: Pick<HelpArticle, "slug" | "category">,
  enabled: ReadonlySet<ModuleId>,
): boolean {
  const id = moduleForArticle(article);
  if (MANDATORY_MODULE_IDS.includes(id)) return true;
  return enabled.has(id);
}

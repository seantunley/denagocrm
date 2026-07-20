import assert from "node:assert/strict";
import test from "node:test";
import { ALL_MODULE_IDS, type ModuleId } from "../src/lib/modules/registry";
import { moduleForArticle, isArticleEnabled } from "../src/lib/help/modules";
import { HELP_ARTICLES, categoriesWithArticles, articlesInCategory, getArticle } from "../src/lib/help/content";

const stub = (slug: string, category: string) =>
  ({ slug, category } as Parameters<typeof moduleForArticle>[0]);

test("moduleForArticle maps by category, prefix and exact slug (unknown → core)", () => {
  // Category defaults
  assert.equal(moduleForArticle(stub("welcome", "getting-started")), "core");
  assert.equal(moduleForArticle(stub("quotes-overview", "sales")), "core");
  assert.equal(moduleForArticle(stub("jobcards-overview", "workshop")), "automotive");
  assert.equal(moduleForArticle(stub("campaigns-overview", "marketing")), "marketing");
  assert.equal(moduleForArticle(stub("chatbot-setup", "automation")), "automation");
  assert.equal(moduleForArticle(stub("stock-purchase-orders-and-receiving", "stock")), "commerce");
  // Prefix overrides split the mixed "comms" and "stock" categories
  assert.equal(moduleForArticle(stub("inbox-overview", "comms")), "inbox");
  assert.equal(moduleForArticle(stub("connect-whatsapp", "comms")), "inbox");
  assert.equal(moduleForArticle(stub("cases-overview", "comms")), "support");
  assert.equal(moduleForArticle(stub("helpdesk-settings", "comms")), "support");
  assert.equal(moduleForArticle(stub("stock-vehicles-registration", "stock")), "automotive");
  // Exact-slug overrides (article lives in one category, owns another route)
  assert.equal(moduleForArticle(stub("fleets-management", "crm")), "automotive");
  assert.equal(moduleForArticle(stub("deliveries-board", "sales")), "automotive");
  assert.equal(moduleForArticle(stub("referrals-overview", "sales")), "marketing");
  assert.equal(moduleForArticle(stub("admin-portal-access", "admin")), "portal");
});

test("isArticleEnabled keeps core regardless of the enabled set", () => {
  const none = new Set<ModuleId>();
  assert.equal(isArticleEnabled(stub("welcome", "getting-started"), none), true);
  assert.equal(isArticleEnabled(stub("jobcards-overview", "workshop"), none), false);
});

test("every real help article resolves to a known module id", () => {
  for (const a of HELP_ARTICLES) {
    assert.ok(ALL_MODULE_IDS.includes(moduleForArticle(a)), `bad module for ${a.slug}`);
  }
});

test("all modules enabled is behaviour-preserving", () => {
  const all = new Set<ModuleId>(ALL_MODULE_IDS);
  const withSet = categoriesWithArticles(all).flatMap((c) => c.articles.map((a) => a.slug)).sort();
  const unfiltered = categoriesWithArticles().flatMap((c) => c.articles.map((a) => a.slug)).sort();
  assert.deepEqual(withSet, unfiltered);
  assert.equal(withSet.length, HELP_ARTICLES.length);
});

test("disabling automotive hides its help articles but keeps core", () => {
  const noAuto = new Set<ModuleId>(ALL_MODULE_IDS.filter((id) => id !== "automotive"));

  // Landing / nav: the whole Workshop category drops out.
  const cats = categoriesWithArticles(noAuto);
  assert.ok(!cats.some((c) => c.key === "workshop"), "workshop category should be gone");
  assert.ok(cats.some((c) => c.key === "getting-started"), "core category stays");

  // A cross-category automotive article (in the CRM category) is also hidden.
  assert.ok(
    !articlesInCategory("crm", noAuto).some((a) => a.slug === "fleets-management"),
    "fleets article should be hidden when automotive is off",
  );
  // ...but core CRM articles remain.
  assert.ok(articlesInCategory("crm", noAuto).some((a) => a.slug === "contacts-overview"));

  // Direct-URL gating: getArticle still finds it, isArticleEnabled says no.
  const jobcards = getArticle("jobcards-overview");
  assert.ok(jobcards, "article exists");
  assert.equal(isArticleEnabled(jobcards!, noAuto), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { HELP_ARTICLES, getArticle, searchArticles, HELP_SEARCH_INDEX } from "../src/lib/help/content";
import { HELP_CATEGORIES } from "../src/lib/help/categories";

/**
 * Structural guards on the article set itself.
 *
 * The Help Centre assembles articles from a hand-authored module plus nine JSON
 * files, and `getArticle` indexes them into a Map keyed on slug. A duplicate
 * slug therefore does not error — the last one silently wins, the other becomes
 * unreachable by URL while still occupying a row in its category list. That is
 * exactly the failure that arrives when an article is re-authored by hand under
 * a slug the generated set still carries (see REPLACED_MARKETING_SLUGS), and it
 * is invisible in the UI, so it has to be a test.
 */

test("article slugs are unique across every source file", () => {
  const seen = new Map<string, number>();
  for (const article of HELP_ARTICLES) {
    seen.set(article.slug, (seen.get(article.slug) ?? 0) + 1);
  }
  const duplicates = [...seen].filter(([, count]) => count > 1).map(([slug]) => slug);
  assert.deepEqual(duplicates, [], `duplicate help slugs: ${duplicates.join(", ")}`);
});

test("every article lands in a real category, so none is unreachable", () => {
  const known = new Set(HELP_CATEGORIES.map((category) => category.key));
  for (const article of HELP_ARTICLES) {
    assert.ok(known.has(article.category), `${article.slug} has unknown category ${article.category}`);
  }
});

test("every article is findable by slug and carries a body", () => {
  for (const article of HELP_ARTICLES) {
    assert.equal(getArticle(article.slug)?.slug, article.slug, `${article.slug} not resolvable`);
    assert.ok(article.title.trim(), `${article.slug} has no title`);
    assert.ok(article.summary.trim(), `${article.slug} has no summary`);
    assert.ok(article.keywords.length > 0, `${article.slug} has no keywords`);
    assert.ok(article.body.length > 0, `${article.slug} has an empty body`);
  }
});

test("table blocks have a cell for every column", () => {
  for (const article of HELP_ARTICLES) {
    for (const block of article.body) {
      if (block.type !== "table") continue;
      for (const row of block.rows) {
        assert.equal(
          row.length,
          block.headers.length,
          `${article.slug}: table row has ${row.length} cells for ${block.headers.length} headers`,
        );
      }
    }
  }
});

test("the search index covers the whole article set", () => {
  assert.equal(HELP_SEARCH_INDEX.length, HELP_ARTICLES.length);
});

test("X setup and the Attention Centre are documented as shipped", () => {
  const x = getArticle("connect-x-social-inbox");
  const attention = getArticle("attention-centre-guide");
  assert.ok(x, "missing X integration setup article");
  assert.ok(attention, "missing Attention Centre article");
  const xText = JSON.stringify(x);
  const attentionText = JSON.stringify(attention);
  for (const required of ["dm.received", "post.mention.create", "post.reply.create", "offline.access", "Grok"]) {
    assert.ok(xText.toLowerCase().includes(required.toLowerCase()), `X setup article is missing ${required}`);
  }
  assert.match(attentionText, /X DMs, mentions and replies/i);
  assert.match(attentionText, /four hours/i);
  assert.ok(searchArticles("connect X webhook").some((article) => article.slug === "connect-x-social-inbox"));
});

/**
 * The retired engine, specifically.
 *
 * The AutomationRule builder is gone and its rules were converted into
 * journeys. Documentation that still tells someone to "click New automation" is
 * worse than none, so the words that only made sense in that builder must not
 * come back — while "automation rule" itself stays searchable, because that is
 * what people still type.
 */
test("no article still instructs the reader to use the retired rules builder", () => {
  const retired = [/click new automation/i, /new automation and give the rule/i];
  for (const article of HELP_ARTICLES) {
    const text = JSON.stringify(article);
    for (const pattern of retired) {
      assert.ok(!pattern.test(text), `${article.slug} still describes the retired automation rules builder`);
    }
  }
});

test("someone searching for the old name is told where automation rules went", () => {
  const results = searchArticles("automation rule");
  assert.ok(results.length > 0, "no article answers a search for \"automation rule\"");
  assert.equal(results[0].slug, "automations-rules", "the redirect article should rank first");
});

test("the run modes, the trace and the test run are all documented", () => {
  for (const slug of [
    "journeys-run-modes",
    "journeys-activity-trace",
    "journeys-test-on-a-lead",
    "journeys-branches-and-loops",
    "journeys-wait-for-an-event",
    "journeys-variables",
  ]) {
    assert.ok(getArticle(slug), `missing journey article: ${slug}`);
  }
});

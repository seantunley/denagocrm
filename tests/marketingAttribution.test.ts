import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { marketingEfficiency } from "../src/lib/marketingOverview";

const migration = readFileSync(new URL("../prisma/migrations/20260724220000_marketing_attribution/migration.sql", import.meta.url), "utf8");

test("marketing efficiency calculates ROAS and cost per lead", () => {
  assert.deepEqual(marketingEfficiency({ spendCents: 100_000, attributedRevenueCents: 450_000, leads: 10 }), {
    roas: 4.5,
    costPerLeadCents: 10_000,
  });
});

test("marketing efficiency refuses invented ratios without denominators", () => {
  assert.deepEqual(marketingEfficiency({ spendCents: 0, attributedRevenueCents: 450_000, leads: 0 }), {
    roas: null,
    costPerLeadCents: null,
  });
});

test("attribution migration uses bounded last-click windows and idempotent event keys", () => {
  assert.match(migration, /attributionWindowDays/);
  assert.match(migration, /last_touch/);
  assert.match(migration, /MarketingTouch_eventKey_key/);
  assert.match(migration, /CampaignConversion_eventKey_key/);
  assert.match(migration, /denago_latest_campaign_touch/);
});

test("attribution hooks leads, won sales and quotes", () => {
  assert.match(migration, /Lead_campaign_attribution_insert/);
  assert.match(migration, /Lead_campaign_attribution_won/);
  assert.match(migration, /Quote_campaign_attribution/);
  assert.match(migration, /sale_won/);
  assert.match(migration, /quote_accepted/);
});

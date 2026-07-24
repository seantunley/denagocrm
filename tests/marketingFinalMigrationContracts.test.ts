import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function migration(path: string) {
  return readFileSync(new URL(`../prisma/migrations/${path}/migration.sql`, import.meta.url), "utf8");
}

const campaign = migration("20260724150000_campaign_lifecycle");
const content = migration("20260724183000_marketing_audiences_templates");
const survey = migration("20260724190000_survey_lifecycle_versioning");
const distribution = migration("20260724200000_survey_distributions_queue");
const followUp = migration("20260724210000_survey_closed_loop_feedback");
const attribution = migration("20260724220000_marketing_attribution");
const hardening = migration("20260724230000_marketing_final_hardening");

test("campaign migration preserves historical rows and adds governed ledgers", () => {
  assert.match(campaign, /CampaignVersion/);
  assert.match(campaign, /CampaignEvent/);
  assert.match(campaign, /completed_with_errors/);
  assert.match(campaign, /failed_permanent/);
});

test("audiences and templates have immutable version ledgers", () => {
  assert.match(content, /MarketingAudienceVersion/);
  assert.match(content, /MarketingTemplateVersion/);
  assert.match(content, /ruleTree/);
  assert.match(content, /plainTextBody/);
});

test("surveys have immutable versions and one active trigger owner", () => {
  assert.match(survey, /SurveyVersion/);
  assert.match(survey, /publishedVersion/);
  assert.match(survey, /Survey_one_active_trigger_per_tenant/);
});

test("survey distributions include queue retry reminder and completion infrastructure", () => {
  assert.match(distribution, /SurveyDistribution/);
  assert.match(distribution, /nextAttemptAt/);
  assert.match(distribution, /reminderCount/);
  assert.match(distribution, /suppressionReason/);
});

test("closed-loop feedback is idempotent per response", () => {
  assert.match(followUp, /SurveyFollowUp_response_key/);
  assert.match(followUp, /ON CONFLICT \("surveyResponseId"\) DO NOTHING/);
});

test("attribution uses idempotent touch and conversion keys with bounded last click", () => {
  assert.match(attribution, /MarketingTouch_eventKey_key/);
  assert.match(attribution, /CampaignConversion_eventKey_key/);
  assert.match(attribution, /denago_latest_campaign_touch/);
  assert.match(attribution, /attributionWindowDays/);
});

test("final migration adds queue leases review separation and bounded configuration", () => {
  assert.match(hardening, /submittedById/);
  assert.match(hardening, /nextAttemptAt/);
  assert.match(hardening, /Campaign_attribution_window_days_check/);
  assert.match(hardening, /SurveyDistribution_reminder_bounds_check/);
  assert.match(hardening, /denago_reconcile_campaign_conversion_totals/);
});

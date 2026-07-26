import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const legacyCampaignActions = source("src/app/actions/campaigns.ts");
const legacySurveyActions = source("src/app/actions/surveys.ts");
const campaignQueue = source("src/lib/marketingCampaignQueue.ts");
const surveyQueue = source("src/lib/surveyDistributionQueue.ts");
const campaignWorkflow = source("src/lib/marketingCampaignWorkflow.ts");
const audiences = source("src/lib/marketingAudiences.ts");
const surveyRuntime = source("src/lib/governedSurveyRuntime.ts");
const surveyPage = source("src/app/s/[token]/page.tsx");
const cron = source("src/app/api/cron/automations/route.ts");
const marketingLayout = source("src/app/(app)/marketing/layout.tsx");
const helpContent = source("src/lib/help/content.ts");

test("legacy campaign and survey actions cannot bypass governed queues", () => {
  assert.doesNotMatch(legacyCampaignActions, /sendCampaignBatch\(/);
  assert.match(legacyCampaignActions, /Direct campaign launch has been retired/);
  assert.match(legacySurveyActions, /Direct audience sends have been retired/);
  assert.match(legacySurveyActions, /submitFrozenSurveyResponse/);
});

test("tenant cron runs only the durable campaign and survey queues", () => {
  assert.match(cron, /runSafeCampaignQueue/);
  assert.match(cron, /runSafeSurveyDistributionQueue/);
  assert.doesNotMatch(cron, /runSurveyQueue\(/);
});

test("campaign and survey queues claim work atomically and recheck policy", () => {
  for (const queue of [campaignQueue, surveyQueue]) {
    assert.match(queue, /FOR UPDATE OF r SKIP LOCKED/);
    assert.match(queue, /canContactPerson/);
    assert.match(queue, /tenantId\" IS NOT DISTINCT FROM/);
    assert.match(queue, /stale_claim_recovered/);
  }
});

test("campaign workflow snapshots lifecycle and launch inside transactions", () => {
  assert.match(campaignWorkflow, /transitionCampaignWithVersion/);
  assert.match(campaignWorkflow, /pg_advisory_xact_lock/);
  assert.match(campaignWorkflow, /The person who submitted a campaign cannot approve it/);
  assert.match(campaignWorkflow, /resolvedContactIds/);
  assert.match(campaignWorkflow, /createMany/);
});

test("advanced audiences are validated versioned and evaluated at launch", () => {
  assert.match(audiences, /validateAudienceTree/);
  assert.match(audiences, /MAX_DEPTH/);
  assert.match(audiences, /MAX_RULES/);
  assert.match(audiences, /audience-version:/);
  assert.match(campaignWorkflow, /evaluateAudience/);
  assert.match(campaignWorkflow, /MarketingAudienceVersion/);
});

test("public survey rendering and submission use frozen published versions", () => {
  assert.match(surveyPage, /loadFrozenSurveyResponse/);
  assert.match(surveyRuntime, /SurveyVersion/);
  assert.match(surveyRuntime, /validateAnswer/);
  assert.match(surveyRuntime, /status\" <> 'completed'/);
});

test("governed marketing routes are module gated and help replaces legacy guidance", () => {
  assert.match(marketingLayout, /requireModuleEnabled\("marketing"\)/);
  assert.match(helpContent, /marketing-governance\.json/);
  assert.match(helpContent, /REPLACED_MARKETING_SLUGS/);
});

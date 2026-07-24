import test from "node:test";
import assert from "node:assert/strict";
import {
  CAMPAIGN_RECIPIENT_STATUSES,
  CAMPAIGN_STATUSES,
  assertCampaignTransition,
  campaignFinalStatus,
  canTransitionCampaign,
  isCampaignEditable,
  isCampaignLaunchable,
  isCampaignRecipientStatus,
  isCampaignStatus,
} from "../src/lib/campaignLifecycle";

test("contains every governed campaign lifecycle status", () => {
  assert.deepEqual(CAMPAIGN_STATUSES, [
    "draft", "in_review", "changes_requested", "approved", "scheduled",
    "queued", "sending", "paused", "completed", "completed_with_errors",
    "failed", "cancelled", "archived",
  ]);
});

test("allows only the documented campaign transitions", () => {
  assert.equal(canTransitionCampaign("draft", "in_review"), true);
  assert.equal(canTransitionCampaign("in_review", "approved"), true);
  assert.equal(canTransitionCampaign("approved", "scheduled"), true);
  assert.equal(canTransitionCampaign("scheduled", "queued"), true);
  assert.equal(canTransitionCampaign("queued", "sending"), true);
  assert.equal(canTransitionCampaign("sending", "paused"), true);
  assert.equal(canTransitionCampaign("paused", "queued"), true);
  assert.equal(canTransitionCampaign("completed", "archived"), true);

  assert.equal(canTransitionCampaign("draft", "queued"), false);
  assert.equal(canTransitionCampaign("in_review", "scheduled"), false);
  assert.equal(canTransitionCampaign("approved", "sending"), false);
  assert.equal(canTransitionCampaign("cancelled", "queued"), false);
  assert.throws(() => assertCampaignTransition("draft", "queued"), /Invalid campaign transition/);
  assert.throws(() => assertCampaignTransition("legacy", "draft"), /Unknown campaign status/);
});

test("locks launch fields after review and approval", () => {
  assert.equal(isCampaignEditable("draft"), true);
  assert.equal(isCampaignEditable("changes_requested"), true);
  assert.equal(isCampaignEditable("in_review"), false);
  assert.equal(isCampaignEditable("approved"), false);
  assert.equal(isCampaignLaunchable("approved"), true);
  assert.equal(isCampaignLaunchable("draft"), false);
});

test("distinguishes clean completion from delivery errors", () => {
  assert.equal(campaignFinalStatus({ failedCount: 0, suppressedCount: 0 }), "completed");
  assert.equal(campaignFinalStatus({ failedCount: 1, suppressedCount: 0 }), "completed_with_errors");
  assert.equal(campaignFinalStatus({ failedCount: 0, suppressedCount: 2 }), "completed_with_errors");
});

test("recognises the governed recipient statuses", () => {
  assert.equal(CAMPAIGN_RECIPIENT_STATUSES.length, 9);
  for (const status of CAMPAIGN_RECIPIENT_STATUSES) assert.equal(isCampaignRecipientStatus(status), true);
  assert.equal(isCampaignRecipientStatus("failed"), false);
  assert.equal(isCampaignStatus("sent"), false);
});

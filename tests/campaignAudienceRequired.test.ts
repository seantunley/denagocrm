import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 2026-11-24: the campaign editor's audience was a free-text label; nothing linked a saved audience, the pre-launch
// check passed any label, and a campaign with no saved audience was worked out from empty rules — everyone who accepts
// marketing. A campaign now goes only to a saved audience of its own workspace.
const code = (path: string) => readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the launch refuses a campaign with no saved audience, and never falls back to empty rules", () => {
  const workflow = code("src/lib/marketingCampaignWorkflow.ts");
  assert.match(workflow, /if \(!campaign\.segmentId\) throw new ActionRefusal\("Choose a saved audience for this campaign before it is scheduled or queued"\);/);
  assert.doesNotMatch(workflow, /segmentId: null, definition:/, "no audience definition without a saved audience");
  // The older resolver gets the workspace by name, not from context.
  assert.match(workflow, /resolveContacts\(args\.tenantId, definition\.definition as SegmentCriteria, args\.channel\)/);
});

test("the pre-launch check wants a live saved audience, not a label", () => {
  const workflow = code("src/lib/marketingCampaignWorkflow.ts");
  assert.match(workflow, /if \(!\(await campaignAudienceFor\(campaign\.segmentId, tenantId\)\)\.segmentId\) issues\.push\(\{ code: "audience", message: "Choose a saved audience"/);
});

test("a saved draft's audience is this workspace's live saved audience, and its label is that audience's name", () => {
  const drafts = code("src/lib/marketingCampaignDrafts.ts");
  assert.match(drafts, /AND "tenantId" IS NOT DISTINCT FROM \$\{tenantId\}\s*AND COALESCE\("status", 'active'\) <> 'archived'/);
  assert.match(drafts, /return rows\[0\] \? \{ segmentId: rows\[0\]\.id, audience: rows\[0\]\.name \} : \{ segmentId: null, audience: NO_AUDIENCE \};/);
  // Both writes go through it.
  assert.equal(drafts.match(/await campaignAudienceFor\(normalised\.segmentId, args\.tenantId\)/g)?.length, 2);
});

test("the editor chooses from saved audiences — there is no typed audience label", () => {
  const editor = code("src/components/marketing/CampaignDraftEditor.tsx");
  assert.match(editor, /<option value="">Choose a saved audience…<\/option>/);
  assert.doesNotMatch(editor, /set\("audience", e\.target\.value\)/);
  assert.match(code("src/app/(app)/marketing/campaigns/[id]/edit/page.tsx"), /<CampaignDraftEditor audiences=\{audiences\}/);
});

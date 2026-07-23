import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");
const pageSource = read("src", "app", "(app)", "campaigns", "page.tsx");
const composerSource = read("src", "components", "CampaignComposer.tsx");

test("campaigns presents a metrics-led workspace with direct create navigation", () => {
  assert.match(pageSource, /WorkspaceHero/);
  assert.match(pageSource, /title="Campaign centre"/);
  assert.match(pageSource, /key: "overview"/);
  assert.match(pageSource, /href="\/campaigns\?tab=new"/);
  assert.match(pageSource, /initialKey=\{initialTab\}/);
  assert.match(pageSource, /recipientCount: true/);
  assert.match(pageSource, /failedCount: true/);
});

test("campaign workflows remain connected across the redesigned tabs", () => {
  assert.match(pageSource, /<CampaignComposer/);
  assert.match(pageSource, /<SegmentBuilder/);
  assert.match(pageSource, /<TemplateManager/);
  assert.match(pageSource, /RecordContextMenu/);
  assert.match(pageSource, /setMarketingOptOut/);
  assert.match(pageSource, /deleteSegment/);
});

test("composer uses icon-led channel choices and preserves campaign actions", () => {
  assert.match(composerSource, /icon=\{Mail\}/);
  assert.match(composerSource, /icon=\{MessageSquareText\}/);
  assert.doesNotMatch(composerSource, /✉️|💬/u);
  assert.match(composerSource, /useActionState\(sendCampaign/);
  assert.match(composerSource, /previewAudience\(formData\)/);
  assert.match(composerSource, /sendCampaignTest\(undefined, formData\)/);
  assert.match(composerSource, /uploadCampaignImage/);
  assert.match(composerSource, /Opted-out customers are always excluded/);
});

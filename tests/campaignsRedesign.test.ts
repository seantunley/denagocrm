import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");
const pageSource = read("src", "app", "(app)", "campaigns", "page.tsx");
const composerSource = read("src", "components", "CampaignComposer.tsx");
const campaignActionsSource = read("src", "app", "actions", "campaigns.ts");
const campaignLibSource = read("src", "lib", "campaigns.ts");
const emailActionsSource = read("src", "app", "actions", "emails.ts");

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

test("campaign workspace reads only the active tenant", () => {
  assert.match(pageSource, /resolveActingTenant\(user\.id\)/);
  assert.match(pageSource, /const tenantId = tenant\.tenantId/);
  assert.match(pageSource, /prisma\.tag\.findMany\(\{ where: \{ tenantId \}/);
  assert.match(pageSource, /prisma\.emailTemplate\.findMany\(\{ where: \{ tenantId \}/);
  assert.match(pageSource, /prisma\.segment\.findMany\(\{ where: \{ tenantId \}/);
  assert.match(pageSource, /prisma\.campaign\.aggregate\(\{\s*where: \{ tenantId \}/s);
  assert.match(pageSource, /resolveContacts\(tenantId, criteria, "any"\)/);
});

test("campaign mutations stamp and constrain tenant ownership", () => {
  assert.match(campaignActionsSource, /resolveActingTenant\(userId\)/);
  assert.match(campaignActionsSource, /findFirst\(\{ where: \{ id: segmentId, tenantId \} \}\)/);
  assert.match(campaignActionsSource, /tenantId,\s*campaignId: created\.id/s);
  assert.match(campaignActionsSource, /deleteMany\(\{ where: \{ id, tenantId \} \}\)/);
  assert.match(campaignActionsSource, /updateMany\(\{\s*where: \{ id: contactId, tenantId \}/s);
  assert.match(campaignLibSource, /const where: any = \{ tenantId, deletedAt: null, marketingOptOut: false \}/);
  assert.match(campaignLibSource, /where: \{ campaignId, tenantId, status: "queued"/);
  assert.match(emailActionsSource, /emailTemplate\.create\(\{ data: \{ tenantId, name, subject, body \} \}\)/);
  assert.match(emailActionsSource, /emailTemplate\.updateMany\(\{\s*where: \{ id, tenantId \}/s);
  assert.match(emailActionsSource, /emailTemplate\.deleteMany\(\{ where: \{ id, tenantId \} \}\)/);
});

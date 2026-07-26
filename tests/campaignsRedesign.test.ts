import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");
const pageSource = read("src", "app", "(app)", "campaigns", "page.tsx");
const campaignActionsSource = read("src", "app", "actions", "campaigns.ts");
const campaignLibSource = read("src", "lib", "campaigns.ts");
const emailActionsSource = read("src", "app", "actions", "emails.ts");

test("campaigns presents a metrics-led workspace with governed create navigation", () => {
  assert.match(pageSource, /WorkspaceHero/);
  assert.match(pageSource, /title="Campaign centre"/);
  assert.match(pageSource, /key: "overview"/);
  // Campaign creation is now governed: create navigation points at /marketing.
  assert.match(pageSource, /href="\/marketing\/campaigns\/new"/);
  assert.match(pageSource, /initialKey=\{initialTab\}/);
  assert.match(pageSource, /recipientCount: true/);
  assert.match(pageSource, /failedCount: true/);
});

test("legacy campaigns screen is read-only and defers launch to /marketing", () => {
  // The direct-launch composer has been retired; the screen keeps reporting,
  // audiences and subscriber-consent management and links out to the governed flow.
  assert.doesNotMatch(pageSource, /<CampaignComposer/);
  assert.match(pageSource, /href="\/marketing\/campaigns"/);
  assert.match(pageSource, /<SegmentBuilder/);
  assert.match(pageSource, /<TemplateManager/);
  assert.match(pageSource, /RecordContextMenu/);
  assert.match(pageSource, /setMarketingOptOut/);
  assert.match(pageSource, /deleteSegment/);
});

test("campaign workspace reads only the active tenant", () => {
  assert.match(pageSource, /resolveActingTenant\(user\.id\)/);
  assert.match(pageSource, /const tenantId = tenant\.tenantId/);
  assert.match(pageSource, /prisma\.tag\.findMany\(\{ where: \{ tenantId \}/);
  assert.match(pageSource, /prisma\.emailTemplate\.findMany\(\{ where: \{ tenantId \}/);
  assert.match(pageSource, /prisma\.segment\.findMany\(\{ where: \{ tenantId \}/);
  assert.match(pageSource, /prisma\.campaign\.aggregate\(\{[\s\S]*?where: \{ tenantId \}/);
  assert.match(pageSource, /resolveContacts\(tenantId, criteria, "any"\)/);
});

test("campaign mutations stamp and constrain tenant ownership", () => {
  assert.match(campaignActionsSource, /resolveActingTenant\(userId\)/);
  assert.match(campaignActionsSource, /findFirst\(\{ where: \{ id: segmentId, tenantId \} \}\)/);
  assert.match(campaignActionsSource, /deleteMany\(\{ where: \{ id, tenantId \} \}\)/);
  assert.match(campaignActionsSource, /updateMany\(\{[\s\S]*?where: \{ id: contactId, tenantId \}/);
  assert.match(campaignLibSource, /const where: any = \{ tenantId, deletedAt: null, marketingOptOut: false \}/);
  assert.match(campaignLibSource, /where: \{ campaignId, tenantId, status: "queued"/);
  assert.match(emailActionsSource, /emailTemplate\.create\(\{ data: \{ tenantId, name, subject, body \} \}\)/);
  assert.match(emailActionsSource, /emailTemplate\.updateMany\(\{[\s\S]*?where: \{ id, tenantId \}/);
  assert.match(emailActionsSource, /emailTemplate\.deleteMany\(\{ where: \{ id, tenantId \} \}\)/);
});

test("direct campaign launch is retired in the legacy actions", () => {
  // Mirror of marketingGovernanceIntegration: no direct provider send from here.
  assert.doesNotMatch(campaignActionsSource, /sendCampaignBatch\(/);
  assert.match(campaignActionsSource, /Direct campaign launch has been retired/);
});

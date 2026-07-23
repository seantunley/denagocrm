import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { verifySendGridSignature } from "../src/lib/sendGridSignature";

const root = process.cwd();
const src = (file: string) => readFileSync(path.join(root, file), "utf8");

test("campaign queue atomically claims recipients before sending", () => {
  const code = src("src/lib/campaigns.ts");
  const claim = code.indexOf("claimCampaignRecipients(");
  const send = code.indexOf("await sendEmail(", claim);
  assert.ok(claim >= 0 && send > claim);
  assert.match(code, /status:\s*"processing"/);
  assert.match(code, /claimId,\s*\n\s*processingAt:/);
  assert.match(code, /status:\s*"queued"[\s\S]*updateMany/);
});

test("campaign creation uses tenant-stampable flat recipient writes", () => {
  const code = src("src/app/actions/campaigns.ts");
  assert.match(code, /campaignRecipient\.createMany/);
  assert.doesNotMatch(code, /recipients:\s*\{\s*create:/);
});

test("consent is rechecked immediately before each campaign send", () => {
  const code = src("src/lib/campaigns.ts");
  const consent = code.indexOf("await canContactPerson(");
  const send = code.indexOf("await sendEmail(", consent);
  assert.ok(consent >= 0 && send > consent);
  assert.match(code, /status:\s*"suppressed"/);
});

test("unsubscribe GET is read-only and POST records withdrawal", () => {
  const code = src("src/app/api/unsubscribe/[token]/route.ts");
  const getStart = code.indexOf("export async function GET");
  const postStart = code.indexOf("export async function POST");
  const getCode = code.slice(getStart, postStart);
  const postCode = code.slice(postStart);
  assert.doesNotMatch(getCode, /marketingOptOut:\s*true/);
  assert.match(postCode, /marketingOptOut:\s*true/);
  assert.match(postCode, /consentRecord\.create/);
  assert.match(postCode, /unsubscribedAt:\s*new Date/);
});

test("SendGrid send payload carries opaque correlation and disables double tracking", () => {
  const code = src("src/lib/email.ts");
  assert.match(code, /crm_campaign_id/);
  assert.match(code, /crm_recipient_id/);
  assert.match(code, /click_tracking:\s*\{\s*enable:\s*false/);
  assert.match(code, /open_tracking:\s*\{\s*enable:\s*false/);
});

test("SendGrid webhook verifies the raw signed body before applying events", () => {
  const code = src("src/app/api/webhooks/sendgrid/route.ts");
  assert.match(code, /const rawBody = await request\.text\(\)/);
  assert.match(code, /x-twilio-email-event-webhook-signature/);
  assert.match(code, /x-twilio-email-event-webhook-timestamp/);
  const verify = code.indexOf("verifySendGridSignature(");
  const apply = code.indexOf("applySendGridEvent(event)");
  assert.ok(verify >= 0 && apply > verify);
  assert.match(code, /withTokenTenantScope\s*\(/);
  assert.match(code, /resolveCampaignRecipientIdTenant/);
});

test("SendGrid signature verifier authenticates timestamp plus exact raw body", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const timestamp = "1784761200";
  const rawBody = '[{"event":"delivered"}]\r\n';
  const signature = crypto
    .sign("sha256", Buffer.from(timestamp + rawBody), privateKey)
    .toString("base64");
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.equal(verifySendGridSignature({ publicKey: pem, signature, timestamp, rawBody }), true);
  assert.equal(
    verifySendGridSignature({ publicKey: pem, signature, timestamp, rawBody: rawBody.trim() }),
    false,
  );
});

test("delivery schema and report distinguish acceptance from delivery", () => {
  const schema = src("prisma/schema.prisma");
  const page = src("src/app/(app)/campaigns/[id]/page.tsx");
  assert.match(schema, /model CampaignEvent/);
  assert.match(schema, /deliveredCount\s+Int/);
  assert.match(schema, /complaintCount\s+Int/);
  assert.match(page, /const deliveredBase = campaign\.deliveredCount \|\| campaign\.sentCount/);
  assert.match(page, /Top clicked links/);
});

test("SendGrid credentials are encrypted settings", () => {
  const code = src("src/lib/settings.ts");
  assert.match(code, /"SENDGRID_API_KEY"/);
  assert.match(code, /"SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY"/);
  assert.match(src("prisma/schema.prisma"), /model TenantEmailProvider/);
  assert.match(src("src/lib/emailProviderConfig.ts"), /resolveActingTenant/);
});

test("Twilio campaign integration roadmap covers rollout and later optimisation", () => {
  const roadmap = src("docs/twilio-email-campaigns-roadmap.md");
  assert.match(roadmap, /Phase 1 — production enablement/);
  assert.match(roadmap, /Phase 4 — analytics that connect to sales/);
  assert.match(roadmap, /Phase 6 — wider Twilio integration/);
  assert.match(roadmap, /POPIA/);
});

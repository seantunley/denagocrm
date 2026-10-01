import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

// Gap audit #33: campaigns, surveys and journeys didn't appear on the customer
// record, and the frequency cap — which counts the customer's outbound
// Communication rows — therefore didn't see them either. Every automated
// marketing sender now leaves a timeline row; this pins that, so a new sender
// can't quietly bypass both the record and the cap again.

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("every campaign / survey send passes a timeline record", () => {
  for (const file of ["src/lib/campaigns.ts", "src/lib/marketingCampaignQueue.ts", "src/lib/surveyDistributionQueue.ts"]) {
    const s = src(file);
    const sends = [...s.matchAll(/await send(Email|Sms)\(([\s\S]*?)\);/g)];
    assert.ok(sends.length > 0, file);
    for (const send of sends) assert.match(send[2], /\brecord\b/, `${file}: a send without a timeline record`);
  }
});

test("journeys and transactional survey invites write their own timeline row after sending", () => {
  const journey = src("src/lib/journeyStepExecutor.ts");
  assert.match(journey, /await sendEmail\(\{ to, subject, text, html: html \?\? undefined \}\);[\s\S]{0,300}await recordCommunication\(context, "email",/);
  assert.match(journey, /await sendSms\(to, message\);[\s\S]{0,300}await recordCommunication\(context, "sms",/);
  assert.match(src("src/lib/surveys.ts"), /prisma\.communication\.create\(\{\s*data: \{\s*type: channel,\s*direction: "outbound",/);
});

test("the frequency cap counts the requested channel's own sends — WhatsApp included", () => {
  const policy = src("src/lib/communicationPolicy.ts");
  const cap = policy.slice(policy.indexOf("if (marketing) {"), policy.indexOf('reason: "frequency_cap"'));
  assert.match(cap, /type: args\.requestedChannel,/);
  assert.doesNotMatch(cap, /"email" \? "email" : "sms"/, "WhatsApp was counted against SMS rows");
});

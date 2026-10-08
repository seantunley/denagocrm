import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  SIGNING_EMAILS,
  SIGNING_EMAIL_KINDS,
  renderSigningEmail,
  renderSms,
  validateSigningTemplate,
} from "../src/lib/signing/emailTemplates";

const BRAND = { companyName: "Acme", tagline: null, logoUrl: null, accent: "#ea580c", accentText: "#ffffff", phone: "", email: "" };
const COMPANY = { company_name: "Acme", company_phone: "021 000 0000", company_email: "hi@acme.test", company_contact: "Acme on 021 000 0000" };
const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("every default template passes its own validation and has a group", () => {
  for (const kind of SIGNING_EMAIL_KINDS) {
    const def = SIGNING_EMAILS[kind];
    assert.equal(validateSigningTemplate(kind, def.subject, def.body), null, kind);
    assert.ok(def.group, kind);
    assert.equal(new Set(SIGNING_EMAIL_KINDS.map((k) => SIGNING_EMAILS[k].settingKey)).size, SIGNING_EMAIL_KINDS.length, "setting keys are unique");
  }
});

test("the standard wording: texts as they were, emails as rewritten 2026-10-08", () => {
  assert.equal(
    renderSms("lookup_code_sms", null, { ...COMPANY, code: "482913" }),
    "Acme: your verification code is 482913. It expires in 10 minutes. If you didn't request this, ignore this message.",
  );
  assert.equal(
    renderSms("recall_sms", null, { ...COMPANY, recall_title: "Brake check", recall_description: "Please book in." }),
    "Brake check: Please book in. Call Acme on 021 000 0000.",
  );
  assert.equal(
    renderSms("service_reminder_sms", null, { ...COMPANY, first_name: "Jo", model: "Rover XL", due_date: "14 Oct 2026" }),
    "Hi Jo, your Rover XL is due for a service (14 Oct 2026). Call Acme on 021 000 0000 to book. Reply STOP to opt out.",
  );
  const recall = renderSigningEmail("recall", null, { ...COMPANY, first_name: "Jo", model: "Rover XL", recall_title: "Brake check", recall_description: "Please book in." }, BRAND);
  assert.equal(recall.subject, "Important notice for your Rover XL: Brake check");
  assert.equal(recall.text, "Dear Jo,\n\nWe are writing to you about your Rover XL.\n\nPlease book in.\n\nThis work will be carried out at no charge to you. Please contact Acme on 021 000 0000 at your earliest convenience so that we can arrange a suitable time.\n\nWe apologise for the inconvenience and thank you for your understanding.\n\nKind regards,\nAcme");
  const portal = renderSigningEmail("portal_code", null, { ...COMPANY, code: "482913" }, BRAND);
  assert.equal(portal.subject, "Your Acme login code");
  assert.match(portal.text, /^Please use the code below to sign in to your Acme customer portal:\n\n482913\n\nThe code is valid for 10 minutes\./);
});

test("SMS: no subject, length-capped, and the code/link can't be dropped", () => {
  assert.equal(validateSigningTemplate("lookup_code_sms", "", "Code {{code}}"), null);
  assert.match(validateSigningTemplate("lookup_code_sms", "", "No code here") ?? "", /must include \{\{code\}\}/);
  assert.match(validateSigningTemplate("recall_sms", "", "x".repeat(641)) ?? "", /too long/);
  assert.match(validateSigningTemplate("recall_sms", "", "Hi {{signing_link}}") ?? "", /Unknown field/);
  // A stored template that lost its action still sends it.
  assert.equal(renderSms("survey_invite_sms", { subject: "", body: "Hi {{first_name}}" }, { first_name: "Jo", survey_link: "https://x.test/s/abc" }), "Hi Jo https://x.test/s/abc");
  // Empty fields don't leave double spaces.
  assert.equal(renderSms("survey_invite_sms", null, { first_name: "Jo", survey_intro: "", survey_link: "https://x.test/s/abc" }), "Hi Jo, https://x.test/s/abc");
});

test("review and survey links become buttons with their own label; a survey link never reaches a subject", () => {
  const review = renderSigningEmail("review_delivery", null, { ...COMPANY, first_name: "Jo", item: "Rover XL", review_link: "https://search.google.com/local/writereview?placeid=P" }, BRAND);
  assert.match(review.html, /v:roundrect[\s\S]*Leave a review<\/center>/);
  assert.match(review.text, /Leave a review here:\nhttps:\/\/search\.google\.com/);
  assert.match(validateSigningTemplate("survey_invite", "Answer {{survey_link}}", "{{survey_link}}") ?? "", /can't go in the subject/);
  const survey = renderSigningEmail("survey_invite", null, { ...COMPANY, first_name: "Jo", survey_intro: "Quick one.", survey_subject: "How did we do?", survey_link: "https://x.test/s/tok" }, BRAND);
  assert.equal(survey.subject, "How did we do?");
  assert.match(survey.html, /Answer the survey<\/a>/);
});

test("every sender uses its editable template — no customer wording left in code", () => {
  const wiring: Array<[string, RegExp[]]> = [
    ["src/app/actions/portal.ts", [/tenantEmailContent\("portal_code"/]],
    ["src/app/api/service-lookup/route.ts", [/tenantSmsContent\("lookup_code_sms"/, /tenantEmailContent\("lookup_code"/]],
    ["src/lib/serviceReminders.ts", [/tenantEmailContent\("service_reminder"/, /tenantSmsContent\("service_reminder_sms"/]],
    ["src/app/actions/warranty.ts", [/tenantEmailContent\("recall"/, /tenantSmsContent\("recall_sms"/]],
    ["src/lib/reviewRequests.ts", [/"review_delivery" : "review_service"/]],
    ["src/lib/surveys.ts", [/tenantEmailContent\("survey_invite"/, /tenantSmsContent\("survey_invite_sms"/]],
  ];
  for (const [file, patterns] of wiring) for (const re of patterns) assert.match(src(file), re, file);
  // The old hard-coded sentences are gone from the senders.
  const gone: Array<[string, RegExp]> = [
    ["src/app/actions/portal.ts", /Your login code is \$\{code\}/],
    ["src/app/api/service-lookup/route.ts", /your verification code is \$\{code\}/],
    ["src/lib/serviceReminders.ts", /A quick reminder that your \$\{vehicle\.model\}/],
    ["src/app/actions/warranty.ts", /to arrange this at no charge/],
    ["src/lib/reviewRequests.ts", /welcome to the \$\{company\.name\} family/],
    ["src/lib/surveys.ts", /Tap here to answer/],
  ];
  for (const [file, re] of gone) assert.doesNotMatch(src(file), re, file);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { validEmailDraft, EMAIL_DRAFT_TTL, type EmailComposerDraft } from "../src/lib/emailComposerDraft";
const now = 1_800_000_000_000;
const data: EmailComposerDraft = {
  to: "customer@example.com", cc: "", bcc: "", replyTo: "sales@example.com",
  subject: "Your quote", body: "<p>Hello</p>", banner: "", dealId: "deal1",
  attached: ["library1"], attachedQuotes: ["quote1"],
  uploads: [new File(["PDF content"], "quote.pdf", { type: "application/pdf" })], secure: false, days: 7,
};
const saved = { key: "tenant1:user1:customer1", version: 1, savedAt: now, data };
test("current drafts retain actual uploaded files and filing context", () => {
  assert.ok(validEmailDraft(saved, saved.key, now));
});
test("recovery rejects a different workspace/account/record and expired or future drafts", () => {
  for (const key of ["tenant2:user1:customer1", "tenant1:user2:customer1", "tenant1:user1:customer2"]) assert.equal(validEmailDraft(saved, key, now), false);
  assert.equal(validEmailDraft(saved, saved.key, now + EMAIL_DRAFT_TTL + 1), false);
  assert.equal(validEmailDraft(saved, saved.key, now - 1), false);
});
test("malformed browser storage never becomes a sendable draft", () => {
  for (const invalid of [null, {}, { ...saved, version: 2 }, { ...saved, savedAt: NaN },
    { ...saved, data: { ...data, subject: null } }, { ...saved, data: { ...data, attached: [123] } },
    { ...saved, data: { ...data, days: 365 } }, { ...saved, data: { ...data, uploads: [{ name: "fake.pdf", size: 1 }] } },
    { ...saved, data: { ...data, uploads: Array(6).fill(data.uploads[0]) } },
    { ...saved, data: { ...data, uploads: [new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.pdf")] } },
  ]) assert.equal(validEmailDraft(invalid, saved.key, now), false);
});

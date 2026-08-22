import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { deliveryHandoverReadiness } from "../src/lib/checklists/deliveryHandover";

const actionSource = readFileSync("src/app/actions/guidedDelivery.ts", "utf8");
const pageSource = readFileSync("src/app/(app)/deliveries/page.tsx", "utf8");
const completionSource = readFileSync("src/components/checklists/GuidedDeliveryCompletion.tsx", "utf8");
const deliveryNoteSource = readFileSync("src/app/(print)/quotes/[id]/delivery-note/page.tsx", "utf8");

test("guided delivery is unavailable rather than implicitly complete with no template", () => {
  assert.deepEqual(deliveryHandoverReadiness([], []), {
    configured: false,
    ready: false,
    missingTemplateIds: [],
  });
});

test("every active handover template needs a completed run before signing unlocks", () => {
  const templates = [{ id: "walkaround" }, { id: "customer-handover" }];
  const partial = deliveryHandoverReadiness(templates, [
    { templateId: "walkaround", completedAt: new Date() },
    { templateId: "customer-handover", completedAt: null },
  ]);
  assert.equal(partial.configured, true);
  assert.equal(partial.ready, false);
  assert.deepEqual(partial.missingTemplateIds, ["customer-handover"]);

  const complete = deliveryHandoverReadiness(templates, [
    { templateId: "walkaround", completedAt: new Date() },
    { templateId: "customer-handover", completedAt: new Date() },
  ]);
  assert.equal(complete.ready, true);
  assert.deepEqual(complete.missingTemplateIds, []);
});

test("server completion repeats the checklist, review, driver and signature gates", () => {
  assert.match(actionSource, /requireQuoteAccess\(quoteId, "deliveries\.manage"\)/);
  assert.match(actionSource, /host: "quote\.delivery", active: true/);
  assert.match(actionSource, /hostType: "quote\.delivery"/);
  assert.match(actionSource, /deliveryNoteReviewed/);
  assert.match(actionSource, /deliveredByName/);
  assert.match(actionSource, /SIGNATURE_PREFIX/);
  assert.match(actionSource, /deliveryHandoverReadiness\(templates, runs\)/);
  assert.match(actionSource, /return markDelivered\(quoteId, formData\)/);
});

test("the guided UI reviews the actual delivery note before showing signature", () => {
  const reviewAt = completionSource.indexOf("Delivery note preview");
  const continueAt = completionSource.indexOf("Delivery note reviewed — continue");
  const signatureAt = completionSource.indexOf("Customer signature");
  assert.ok(reviewAt >= 0);
  assert.ok(continueAt > reviewAt);
  assert.ok(signatureAt > continueAt);
  assert.match(completionSource, /`\/quotes\/\$\{quoteId\}\/delivery-note`/);
  assert.match(completionSource, /previewHref = `\$\{noteHref\}\?embed=1`/);
  assert.match(completionSource, /src=\{previewHref\}/);
  assert.match(completionSource, /completeGuidedDelivery\.bind\(null, quoteId\)/);
});

test("embedded delivery-note review hides its nested print toolbar", () => {
  assert.match(deliveryNoteSource, /embed\?: string/);
  assert.match(deliveryNoteSource, /const embedded = embed === "1"/);
  assert.match(deliveryNoteSource, /\{!embedded && <PrintActions/);
});

test("the delivery note shows the guided snapshots being signed, then the stored signature", () => {
  assert.match(deliveryNoteSource, /prisma\.checklistRun\.findMany/);
  assert.match(deliveryNoteSource, /hostType: "quote\.delivery"/);
  assert.match(deliveryNoteSource, /labelSnapshot/);
  assert.match(deliveryNoteSource, /captureSnapshot/);
  assert.match(deliveryNoteSource, /latestRunByTemplate/);
  assert.match(deliveryNoteSource, /tag: "delivery-signature"/);
  assert.match(deliveryNoteSource, /src=\{`\/api\/files\/\$\{signatureDoc\.id\}`\}/);
});

test("Deliveries uses the old proof-of-delivery only as an unconfigured fallback", () => {
  assert.match(pageSource, /handover\?\.configured \? \(/);
  assert.match(pageSource, /handover\.ready \? \(/);
  assert.match(pageSource, /<GuidedDeliveryCompletion quoteId=\{quote\.id\} \/>/);
  assert.match(pageSource, /No guided delivery checklist is configured/);
  assert.match(pageSource, /<ProofOfDelivery quoteId=\{quote\.id\} \/>/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { deliveryHandoverReadiness } from "../src/lib/checklists/deliveryHandover";

const actionSource = readFileSync("src/app/actions/guidedDelivery.ts", "utf8");
const pageSource = readFileSync("src/app/(app)/deliveries/page.tsx", "utf8");
const completionSource = readFileSync("src/components/checklists/GuidedDeliveryCompletion.tsx", "utf8");

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
  assert.match(completionSource, /completeGuidedDelivery\.bind\(null, quoteId\)/);
});

test("Deliveries uses the old proof-of-delivery only as an unconfigured fallback", () => {
  assert.match(pageSource, /handover\?\.configured \? \(/);
  assert.match(pageSource, /handover\.ready \? \(/);
  assert.match(pageSource, /<GuidedDeliveryCompletion quoteId=\{quote\.id\} \/>/);
  assert.match(pageSource, /No guided delivery checklist is configured/);
  assert.match(pageSource, /<ProofOfDelivery quoteId=\{quote\.id\} \/>/);
});

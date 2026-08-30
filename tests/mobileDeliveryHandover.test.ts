import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deliveries = readFileSync(path.join(root, "src/app/(app)/deliveries/page.tsx"), "utf8");
const mobileStart = deliveries.indexOf("<MobileOnly");
const desktopStart = deliveries.indexOf("<DesktopOnly");
const mobile = deliveries.slice(mobileStart, desktopStart);

test("mobile handovers can open the delivery note without leaving the PWA flow", () => {
  assert.ok(mobileStart >= 0 && desktopStart > mobileStart, "mobile deliveries section must exist before desktop");
  assert.ok(
    mobile.includes('href={`/quotes/${quote.id}/delivery-note`}'),
    "the mobile handover card must link directly to its delivery note",
  );
  assert.ok(mobile.includes("Review delivery note"), "the handover action must say what it opens");
  assert.doesNotMatch(mobile, /target="_blank"/, "mobile review should keep browser/PWA back navigation intact");
});

/*
 * SIGNING MOVED INTO THE HANDOVER BLOCK, and there must be exactly one of it.
 *
 * The guided flow decides whether a checklist is configured and refuses to sign
 * until every one is complete. This section used to carry its own
 * <ProofOfDelivery> as well, which put two signing controls on one card — and
 * the second consulted no checklist at all, so a delivery with a guided handover
 * configured could be signed straight past it.
 */
test("mobile scheduled deliveries offer exactly one signature workflow", () => {
  assert.ok(mobile.includes('const stageKey = colOf(quote);'), "mobile must retain the quote fulfilment stage");
  assert.match(
    mobile,
    /stageKey === "deliver" && checklist &&/,
    "the handover block is what a scheduled delivery opens",
  );
  // Either the guided completion, or the legacy control when nothing is
  // configured — chosen in ONE place, by the branch that knows.
  assert.match(mobile, /handover\?\.configured \?/);
  assert.match(mobile, /<GuidedDeliveryCompletion quoteId=\{quote\.id\} runIds=\{handoverRuns\} \/>/);
  assert.equal(
    (mobile.match(/<ProofOfDelivery /g) ?? []).length,
    1,
    "one signing control on the card, reached only when no guided handover is configured",
  );
});

test("delivery-note review appears before signing, and signing is not offered before scheduling", () => {
  const review = mobile.indexOf("Review delivery note");
  const signature = mobile.indexOf("<GuidedDeliveryCompletion");
  assert.ok(review >= 0 && signature >= 0, "both the review link and the signing step must exist");
  assert.match(
    mobile,
    /stageKey === "schedule" \|\| stageKey === "deliver"/,
    "delivery-note controls should only appear in the handover-ready stages",
  );
  assert.ok(
    mobile.includes("Customer signing becomes available here once the delivery is scheduled."),
    "the pre-scheduled state must explain why signing is not available yet",
  );
  // …and once it IS scheduled, the copy points at the handover rather than
  // promising a signature control that no longer sits in this section.
  assert.ok(
    mobile.includes("complete the handover above to capture the driver and customer signature"),
    "the scheduled state must say where signing actually happens",
  );
});

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

test("mobile scheduled deliveries reuse the existing proof-of-delivery signature workflow", () => {
  assert.ok(mobile.includes('const stageKey = colOf(quote);'), "mobile must retain the quote fulfilment stage");
  assert.match(
    mobile,
    /canManage && stageKey === "deliver"[\s\S]*?<ProofOfDelivery quoteId=\{quote\.id\} \/>/,
    "a scheduled delivery must expose the existing driver/checklist/signature handover",
  );
});

test("delivery-note review appears before signing, and signing is not offered before scheduling", () => {
  const review = mobile.indexOf("Review delivery note");
  const signature = mobile.indexOf("<ProofOfDelivery quoteId={quote.id} />");
  assert.ok(review >= 0 && signature > review, "review must lead into the signature step");
  assert.match(
    mobile,
    /stageKey === "schedule" \|\| stageKey === "deliver"/,
    "delivery-note controls should only appear in the handover-ready stages",
  );
  assert.ok(
    mobile.includes("Customer signing becomes available here once the delivery is scheduled."),
    "the pre-scheduled state must explain why signing is not available yet",
  );
});

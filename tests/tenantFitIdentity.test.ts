import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { standardTemplateFor } from "../src/lib/doceditor/standardTemplates";
import { DEFAULT_FLOW } from "../src/lib/flow";
import { FLOW_TEMPLATES } from "../src/lib/flowTemplates";
import { journeyTemplateVars } from "../src/lib/journeyContext";

/**
 * Tenant-fit audit 2026-10-03, PR B. Every workspace got the founding tenant's
 * identity by default: a quotation with a "vehicle of interest" card and
 * Denago's road-registration disclaimer, chatbots asking what "the cart" needs,
 * "Denago CRM" in sign-in emails and tab titles. A new workspace must start
 * neutral; the automotive wording stays, but only behind the automotive module.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("standard quote is neutral unless the automotive module is on", () => {
  const plain = JSON.stringify(standardTemplateFor("quote"));
  assert.doesNotMatch(plain, /vehicle of interest|Low-Speed Vehicle|build slot|Denago/i);
  const automotive = JSON.stringify(standardTemplateFor("quote", { automotive: true }));
  assert.match(automotive, /vehicle of interest/i);
  assert.match(automotive, /Low-Speed Vehicle/);
});

test("standard quote callers pass the tenant's automotive module", () => {
  for (const file of [
    "src/lib/docbuilder/store.ts",
    "src/app/actions/docbuilder.ts",
    "src/app/actions/doceditor.ts",
    "src/lib/signing/autoEnvelope.ts",
  ]) {
    assert.match(src(file), /automotive: await isModuleEnabled\("automotive"\)/, file);
  }
});

test("default chatbot flows don't assume carts or Denago", () => {
  const flows = JSON.stringify([DEFAULT_FLOW, ...FLOW_TEMPLATES.map((t) => t.definition)]);
  assert.doesNotMatch(flows, /\bcart\b|Denago/i);
});

test("journey {{model}} falls back to neutral wording", () => {
  const vars = journeyTemplateVars({ event: {}, lead: null, contact: null });
  assert.equal(vars.model, "your purchase");
});

test("AI prompts name the tenant's company, not Denago", () => {
  for (const file of ["src/lib/ai.ts", "src/lib/researchPrompt.ts", "src/lib/competitors.ts", "src/lib/flowAiDraft.ts"]) {
    const body = src(file).replace(/^\s*(\/\/|\*).*$/gm, "");
    // DenagoCRM-* is the platform crawler's User-Agent, not prompt text.
    assert.doesNotMatch(body, /Denago(?!CRM-)/, file);
  }
});

test("staff-facing copy no longer says Denago", () => {
  for (const file of [
    "src/app/login/actions.ts",
    "src/app/actions/emails.ts",
    "src/app/actions/push.ts",
    "src/app/actions/stock.ts",
    "src/app/global-error.tsx",
    "src/lib/webauthn.ts",
    "src/components/SidebarHelpSettings.tsx",
    "src/components/PushToggle.tsx",
    "src/components/StockPurchaseOrderForm.tsx",
    "src/components/SigningBlock.tsx",
    "src/components/signing/SignedDocPreview.tsx",
    "src/lib/signing/countersign.ts",
    "src/lib/signing/templateRecipients.ts",
    "src/lib/signflow/compile.ts",
    "src/lib/signflow/model.ts",
    "src/app/(app)/deliveries/page.tsx",
    "src/app/(app)/inbox/page.tsx",
    "src/app/(app)/leads/list/page.tsx",
    "src/app/(app)/referrals/page.tsx",
    "src/app/(app)/products/page.tsx",
    "src/app/(app)/stock/page.tsx",
  ]) {
    const body = src(file)
      .replace(/^\s*(\/\/|\*|\/\*).*$/gm, "")
      // The Meta app is literally named this; it's the platform's, not the tenant's.
      .replace(/the Denago CRM app needs/g, "");
    assert.doesNotMatch(body, /Denago/, file);
  }
});

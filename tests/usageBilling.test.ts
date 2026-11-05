import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { aiCostMicros, invoiceLines, invoiceNumber, invoiceTotals, planAmounts, usageMonth } from "../src/lib/usageMeters";

test("AI cost follows the model's price, with cache and web search", () => {
  assert.equal(aiCostMicros({ input_tokens: 1_000_000, output_tokens: 0 }, "claude-haiku-4-5"), 1_000_000, "$1 per million Haiku input");
  assert.equal(aiCostMicros({ input_tokens: 0, output_tokens: 1_000 }, "claude-opus-5"), 25_000, "$25 per million Opus output");
  assert.equal(aiCostMicros({ cache_read_input_tokens: 1_000_000 }, "claude-sonnet-5"), 200_000, "cache reads at 0.1×");
  assert.equal(aiCostMicros({ cache_creation_input_tokens: 1_000_000 }, "claude-sonnet-5"), 2_500_000, "cache writes at 1.25×");
  assert.equal(aiCostMicros({ server_tool_use: { web_search_requests: 3 } }, "claude-opus-5"), 30_000, "1c a search");
  assert.equal(aiCostMicros({ output_tokens: 1_000 }, "some-new-model"), 25_000, "unknown model priced as Opus");
});

test("the usage month is Johannesburg's", () => {
  assert.equal(usageMonth(new Date("2026-11-30T23:30:00Z")), "2026-12", "01:30 on 1 Dec in SA");
  assert.equal(usageMonth(new Date("2026-11-30T21:00:00Z")), "2026-11");
});

test("an invoice is the plan fee plus whole units over each allowance at its price", () => {
  const plan = {
    name: "Professional",
    monthlyCents: 349_900,
    included: planAmounts({ ai_usd_micros: 20, whatsapp_sent: 1000, sms_sent: 0, junk: 5, ai_calls: 9 }),
    overage: planAmounts({ ai_usd_micros: 2500, whatsapp_sent: 50, voice_chars: -3 }),
  };
  assert.deepEqual(plan.included, { ai_usd_micros: 20, whatsapp_sent: 1000, sms_sent: 0 }, "unknown and non-billable meters dropped");
  assert.deepEqual(plan.overage, { ai_usd_micros: 2500, whatsapp_sent: 50 }, "negative prices dropped");
  const lines = invoiceLines(plan, { ai_usd_micros: 21_200_000, whatsapp_sent: 900, sms_sent: 40 }, "2026-11");
  assert.deepEqual(lines, [
    { label: "Professional: 2026-11", quantity: 1, unitCents: 349_900, totalCents: 349_900 },
    { label: "AI usage over the plan (per US$ of AI)", quantity: 2, unitCents: 2500, totalCents: 5000 },
  ], "$1.20 over → 2 units; WhatsApp under; SMS over but no price → not charged");
  assert.deepEqual(invoiceTotals(lines, 15), { subtotalCents: 354_900, vatCents: 53_235, totalCents: 408_135 });
  assert.deepEqual(invoiceLines({ name: null, monthlyCents: null, included: {}, overage: {} }, { ai_usd_micros: 9e9 }, "2026-11"), [], "no plan, nothing billed");
  assert.equal(invoiceNumber(7), "INV-0007");
});

test("counts can't be lost, and a supplied key is never shown to the workspace", () => {
  const usage = readFileSync("src/lib/usage.ts", "utf8");
  assert.match(usage, /ON CONFLICT \("tenantId", "month", "meter"\) DO UPDATE SET "count" = "UsageCounter"\."count" \+ EXCLUDED\."count"/);
  const settings = readFileSync("src/lib/settings.ts", "utf8");
  assert.match(settings, /if \(!tenant\?\.platformAi \|\| !tenant\.active\) return null;/);
  const integrations = readFileSync("src/components/settings/WorkspaceIntegrationRows.tsx", "utf8");
  assert.doesNotMatch(integrations, /getProviderKey/, "the settings page shows the workspace's own keys only");
  for (const file of ["src/lib/ai.ts", "src/lib/botAi.ts", "src/lib/competitors.ts", "src/lib/elevenlabs.ts", "src/lib/flowAiDraft.ts", "src/lib/flowRuntimeTools.ts", "src/lib/inboundScreening/classify.ts"]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /getSetting\("(ANTHROPIC|ELEVENLABS)_API_KEY"\)/, `${file} reads keys through getProviderKey`);
  }
  for (const file of ["src/lib/ai.ts", "src/lib/botAi.ts", "src/lib/competitors.ts"]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /recordAiUsage\(json\.usage\)/, `${file} passes the model so the cost is priced`);
  }
});

test("invoices: platform admins only, one live per month, and a workspace sees only its own", () => {
  const actions = readFileSync("src/app/actions/platformBilling.ts", "utf8");
  for (const fn of ["setTenantPlanAction", "setInvoiceSettingsAction", "createTenantInvoiceAction", "setInvoiceStatus"]) {
    assert.match(actions, new RegExp(`function ${fn}[\\s\\S]*?const actor = await requirePlatformAdminAction\\(\\)`), `${fn} checks the platform admin`);
  }
  assert.match(actions, /SELECT "id" FROM "Tenant" WHERE "id" = \$\{tenantId\} FOR UPDATE/);
  assert.match(actions, /status: \{ not: "void" \}/);
  const page = readFileSync("src/app/(print)/settings/plan/invoices/[id]/page.tsx", "utf8");
  assert.match(page, /findFirst\(\{ where: \{ id, tenantId \} \}\)/);
  assert.match(readFileSync("src/app/(app)/settings/plan/page.tsx", "utf8"), /await requireTenantOwner\(\);/);
});

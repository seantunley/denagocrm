import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GENERATED_MODEL_PRICES } from "../src/lib/modelPrices.generated";
import { aiCostMicros, chatGptJobForScope, chatGptJobMeter, METERS, modelPrice } from "../src/lib/usageMeters";
import { pricesFrom, render } from "../scripts/update-model-prices.mjs";

// Sean, 2026-11-20 (from Scarlet): the billable AI usage meter is costed from a list refreshed from LiteLLM's public
// prices, not one kept by hand — that priced every new model as Opus.

test("every Claude model the app names has a listed price, and the prices are sane", () => {
  const src = (f: string) => readFileSync(f, "utf8");
  const named = new Set(
    ["src/lib/ai.ts", "src/lib/aiText.ts", "src/lib/competitors.ts", "src/lib/knowledgeGaps.ts", "src/lib/inboundScreening/classify.ts", "src/lib/systemHealth.ts"]
      .flatMap((f) => src(f).match(/"claude-[a-z0-9-]+"/g) ?? [])
      .map((s) => s.slice(1, -1)),
  );
  assert.ok(named.size >= 3);
  for (const id of named) assert.ok(GENERATED_MODEL_PRICES[id], `${id} is named in the code but has no listed price`);
  for (const [id, [input, output, write, read]] of Object.entries(GENERATED_MODEL_PRICES)) {
    assert.ok(input > 0 && output >= input && write >= input && read > 0 && read < input, `${id}: ${[input, output, write, read]}`);
  }
});

test("costing: exact id, then a dated id takes its base, and an unlisted model is priced as Opus", () => {
  assert.deepEqual(modelPrice("claude-sonnet-5-5"), GENERATED_MODEL_PRICES["claude-sonnet-5-5"]);
  assert.deepEqual(modelPrice("claude-opus-5-5-20261101"), GENERATED_MODEL_PRICES["claude-opus-5-5"], "the longest listed base, not claude-opus-5");
  assert.deepEqual(modelPrice("claude-sonnet-9"), [5, 25, 6.25, 0.5]);
  // Cache reads at the listed price, not a guessed 0.1× (Sonnet 5.5 reads at 0.05× input).
  const [, , , read] = GENERATED_MODEL_PRICES["claude-sonnet-5-5"];
  assert.equal(aiCostMicros({ cache_read_input_tokens: 1_000_000 }, "claude-sonnet-5-5"), Math.ceil(read * 1_000_000));
});

test("the script: Anthropic's own ids only, both prices required, and a reshaped file writes nothing", () => {
  const rows = pricesFrom({
    "claude-x-1": { litellm_provider: "anthropic", input_cost_per_token: 0.000002, output_cost_per_token: 0.00001, cache_read_input_token_cost: 0.0000001 },
    "anthropic/claude-x-1": { litellm_provider: "anthropic", input_cost_per_token: 1, output_cost_per_token: 1 },
    "bedrock/claude-x-1": { litellm_provider: "bedrock", input_cost_per_token: 1, output_cost_per_token: 1 },
    "claude-free": { litellm_provider: "anthropic", input_cost_per_token: 0, output_cost_per_token: 0 },
    sample_spec: { litellm_provider: "anthropic" },
  });
  assert.deepEqual(rows, [["claude-x-1", 2, 10, 2.5, 0.1]], "cache write defaults to 1.25× input when the file has none");
  assert.match(render(rows), /"claude-x-1": \[2, 10, 2\.5, 0\.1\],/);
  const script = readFileSync("scripts/update-model-prices.mjs", "utf8");
  assert.match(script, /if \(rows\.length < 5\) throw new Error/);
  assert.equal(readFileSync("src/lib/modelPrices.generated.ts", "utf8"), render(Object.entries(GENERATED_MODEL_PRICES).map(([id, p]) => [id, ...p])), "the file is exactly what the script writes");
});

// ChatGPT (subscription) use is counted per job, never billed.
test("ChatGPT usage: counted on every answer under its job, and never a billable meter", () => {
  assert.equal(METERS.chatgpt_tokens.billable, false);
  assert.equal(METERS.chatgpt_calls.billable, false);
  assert.equal(chatGptJobMeter("DAX"), "chatgpt_tokens:DAX");
  assert.equal(chatGptJobMeter("<b>'; drop"), "chatgpt_tokens:b drop");
  assert.equal(chatGptJobMeter(""), "chatgpt_tokens:Other");
  assert.equal(chatGptJobForScope("bot-ai"), "Chatbot");
  assert.equal(chatGptJobForScope("inbound-screening"), "Spam screening");
  assert.equal(chatGptJobForScope("supplier-invoice-read"), "Invoice reading");
  assert.equal(chatGptJobForScope("crm-assistant-read"), "DAX");
  const codex = readFileSync("src/lib/codex.ts", "utf8");
  assert.match(codex, /\/\*\*[\s\S]*?\*\/\s+job: string;/, "required, so a new caller can't skip it");
  assert.match(codex, /await recordChatGptUsage\(input\.job, \(parsed\.usage\?\.inputTokens \?\? 0\) \+ \(parsed\.usage\?\.outputTokens \?\? 0\)\);\s+return \{ text: parsed\.text/);
  assert.match(readFileSync("src/app/(app)/settings/plan/page.tsx", "utf8"), /chatGptUsageByJob\(tenantId, month\)/);
});

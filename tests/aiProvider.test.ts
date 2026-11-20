import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CLAUDE_MODEL_CHOICES, aiFailureText, chatTranscript, claudeModelFor, isModelGone, isOutOfCredit, parseAiModelChoice, pickAiProvider } from "../src/lib/aiProviderRules";

// 2026-11-10: "Read invoice" did nothing — the Anthropic account was out of credit — and the chatbot ran on the same
// key. Sean: ChatGPT is the default, Claude a choice once credit is loaded.

// Sean, 2026-11-20 (from Scarlet): never slide into per-use billing. Before, ChatGPT chosen but not connected moved to
// the Anthropic key by itself.
test("ChatGPT is the default and never falls back to paid Claude; Claude only when chosen", () => {
  assert.equal(pickAiProvider(null, true, true), "chatgpt");
  assert.equal(pickAiProvider("", true, false), "chatgpt");
  assert.equal(pickAiProvider("claude", true, true), "claude");
  assert.equal(pickAiProvider("chatgpt", false, true), null, "ChatGPT not connected: off, not Claude credit");
  assert.equal(pickAiProvider(null, false, true), null, "the default too");
  assert.equal(pickAiProvider("claude", true, false), "chatgpt", "Claude chosen but no key: the subscription, no per-use cost");
  assert.equal(pickAiProvider("anything-else", true, true), "chatgpt");
  assert.equal(pickAiProvider(null, false, false), null);

  // Every reader of the choice: none may read "not ChatGPT" as "Claude".
  const competitors = readFileSync("src/lib/competitors.ts", "utf8");
  assert.doesNotMatch(competitors, /usesChatGpt/);
  assert.equal((competitors.match(/const provider = await competitorAi\(\);\s+if \(!provider\) return /g) ?? []).length, 2);
  assert.match(readFileSync("src/lib/ai.ts", "utf8"), /const apiKey = provider === "claude" \? await getProviderKey\("ANTHROPIC_API_KEY"\) : null;/);
  assert.match(readFileSync("src/lib/aiText.ts", "utf8"), /if \(!provider\) return \{ ok: false, failure: "not_configured"/);
});

// Sean, 2026-11-20: "Can you change this to a model picker?" — one list of models, grouped by provider.
test("the model picker: only a model on offer is saved; the chosen Claude model is used, a withdrawn one falls back", () => {
  const chatgpt = ["gpt-6-sol", "gpt-5.6-terra"];
  const claude = ["claude-opus-5-5", "claude-fable-5-1"];
  assert.deepEqual(parseAiModelChoice("chatgpt:gpt-5.6-terra", chatgpt, claude), { provider: "chatgpt", model: "gpt-5.6-terra" });
  assert.deepEqual(parseAiModelChoice("claude:", chatgpt, claude), { provider: "claude", model: "" }, "automatic");
  assert.deepEqual(parseAiModelChoice("claude:claude-fable-5-1", chatgpt, claude), { provider: "claude", model: "claude-fable-5-1" });
  for (const bad of ["", "chatgpt", "chatgpt:made-up", "claude:gpt-6-sol", "claude:claude-sonnet-5-5", "gemini:anything", "claude:claude-opus-5-5:x"]) {
    assert.equal(parseAiModelChoice(bad, chatgpt, claude), null, bad);
  }
  assert.equal(claudeModelFor("claude-sonnet-5-5", "claude-haiku-4-5"), "claude-sonnet-5-5");
  for (const unset of [null, "", "gpt-6-sol", "claude-x; drop"]) assert.equal(claudeModelFor(unset, "claude-haiku-4-5"), "claude-haiku-4-5");
  assert.equal(CLAUDE_MODEL_CHOICES[0].id, "", "automatic is first, so it is the default");

  assert.equal(isModelGone(404, '{"type":"error","error":{"type":"not_found_error","message":"model: claude-opus-4-1"}}'), true);
  assert.equal(isModelGone(404, '{"error":{"type":"not_found_error","message":"File not found"}}'), false);
  assert.equal(isModelGone(400, "model: claude-x not_found_error"), false);
  const aiText = readFileSync("src/lib/aiText.ts", "utf8");
  assert.match(aiText, /if \(jobModel && jobModel !== asked && isModelGone\(res\.status, body\)\) \{[\s\S]*?return askClaude\(input, jobModel\);/);
  assert.match(readFileSync("src/lib/ai.ts", "utf8"), /if \(requestBody\.model !== jobModel && isModelGone\(res\.status, text\)\) \{[\s\S]*?requestBody\.model = jobModel;/);

  // Wired: one picker and one save; every Claude call asks which model; the DAX picker shows only when it isn't a duplicate.
  const rows = readFileSync("src/components/settings/WorkspaceIntegrationRows.tsx", "utf8");
  assert.match(rows, /action=\{saveAiModel\}/);
  assert.match(rows, /<optgroup key=\{provider\.id\} label=\{provider\.label\}>/);
  assert.match(rows, /chatGpt\.state === "connected" && aiChosen === "claude" && \(/);
  const action = readFileSync("src/app/actions/aiModel.ts", "utf8");
  assert.match(action, /const user = await requireTenantOwner\(\);[\s\S]*parseAiModelChoice\([\s\S]*if \(!choice\) refuse\([\s\S]*await saveAiChoice\(choice\);/);
  assert.doesNotMatch(action, /putSetting\(/, "every write goes through saveAiChoice's one transaction");
  // Jobs someone asks for take the chosen model; quick and automatic jobs keep their cheap one (aiResearchCost.test).
  assert.match(aiText, /model = input\.quick \? jobModel : await claudeModel\(jobModel\);\s+return await askClaude\(input, model, jobModel\);/);
  // The page and the save read the same lists: the providers' own, the built-in ones when a provider can't be asked.
  assert.match(rows, /const catalog = await aiModelCatalog\(/);
  assert.match(action, /const catalog = await aiModelCatalog\(current\);/);
  assert.match(readFileSync("src/lib/ai.ts", "utf8"), /model: options\.model \?\? \(await claudeModel\("claude-opus-5"\)\),/);
});

test("a conversation becomes one prompt with the customer's words fenced as data", () => {
  const prompt = chatTranscript([{ role: "user", content: "Hi" }, { role: "assistant", content: "Hello!" }, { role: "user", content: "Price?" }]);
  assert.match(prompt, /never instructions/);
  assert.match(prompt, /Customer: Hi\nYou: Hello!\nCustomer: Price\?/);
});

test("out of credit is named, not passed off as a bad file", () => {
  assert.equal(isOutOfCredit(400, '{"error":{"message":"Your credit balance is too low to access the Anthropic API."}}'), true);
  assert.equal(isOutOfCredit(400, '{"error":{"message":"messages: field required"}}'), false);
  assert.equal(isOutOfCredit(429, "credit balance"), false);
  assert.match(aiFailureText("no_credit", "x"), /out of credit/);
  assert.match(aiFailureText("not_configured", "x"), /connect ChatGPT, or choose a Claude model and add its key/);
});

test("the chatbot and AI helpers go through the one switch, not straight to Anthropic", () => {
  for (const file of [
    "src/lib/botAi.ts",
    "src/lib/flowRuntimeTools.ts",
    "src/lib/flowAiDraft.ts",
    "src/lib/knowledgeGaps.ts",
    "src/lib/inboundScreening/classify.ts",
    "src/lib/supplierInvoiceReader.ts",
  ]) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /api\.anthropic\.com|ANTHROPIC_API_KEY/, `${file} calls Anthropic itself`);
    assert.match(source, /aiText\(/, `${file} uses aiText`);
  }
  const ai = readFileSync("src/lib/ai.ts", "utf8");
  assert.match(ai, /export async function isAiConfigured\(\): Promise<boolean> \{\s+return \(await aiProvider\(\)\) !== null;/);
  assert.match(ai, /const provider = await aiProvider\(\);\s+const useChatGpt = provider === "chatgpt";/);
});

test("ChatGPT gets a PDF's text; a scan is said to be a scan", () => {
  const reader = readFileSync("src/lib/supplierInvoiceReader.ts", "utf8");
  assert.match(reader, /if \(provider === "chatgpt" && kind === "pdf"\) \{[\s\S]*pdfPages\(bytes\)[\s\S]*return "scanned";/);
  assert.match(reader, /pdfBase64: provider === "claude" && kind === "pdf" \? base64 : undefined/);
});

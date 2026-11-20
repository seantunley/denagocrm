import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CLAUDE_MODEL_CHOICES, aiFailureText, chatTranscript, claudeModelFor, isOutOfCredit, parseAiModelChoice, pickAiProvider } from "../src/lib/aiProviderRules";

// 2026-11-10: "Read invoice" did nothing — the Anthropic account was out of credit — and the chatbot ran on the same
// key. Sean: ChatGPT is the default, Claude a choice once credit is loaded.

test("ChatGPT is the default; Claude only when chosen; the other one only when the choice isn't set up", () => {
  assert.equal(pickAiProvider(null, true, true), "chatgpt");
  assert.equal(pickAiProvider("", true, false), "chatgpt");
  assert.equal(pickAiProvider("claude", true, true), "claude");
  assert.equal(pickAiProvider("chatgpt", false, true), "claude", "a workspace with only a Claude key keeps working");
  assert.equal(pickAiProvider("claude", true, false), "chatgpt", "Claude chosen but no key");
  assert.equal(pickAiProvider("anything-else", true, true), "chatgpt");
  assert.equal(pickAiProvider(null, false, false), null);
});

// Sean, 2026-11-20: "Can you change this to a model picker?" — one list of models, grouped by provider.
test("the model picker: only a model on offer is saved, and a Claude choice runs every Claude job", () => {
  const chatgpt = ["gpt-6-sol", "gpt-5.6-terra"];
  assert.deepEqual(parseAiModelChoice("chatgpt:gpt-5.6-terra", chatgpt), { provider: "chatgpt", model: "gpt-5.6-terra" });
  assert.deepEqual(parseAiModelChoice("claude:", chatgpt), { provider: "claude", model: "" }, "automatic");
  assert.deepEqual(parseAiModelChoice("claude:claude-opus-5-5", chatgpt), { provider: "claude", model: "claude-opus-5-5" });
  for (const bad of ["", "chatgpt", "chatgpt:made-up", "claude:gpt-6-sol", "gemini:anything", "claude:claude-opus-5-5:x"]) {
    assert.equal(parseAiModelChoice(bad, chatgpt), null, bad);
  }
  assert.equal(claudeModelFor("claude-sonnet-5-5", "claude-haiku-4-5"), "claude-sonnet-5-5");
  for (const unset of [null, "", "claude-retired-1"]) assert.equal(claudeModelFor(unset, "claude-haiku-4-5"), "claude-haiku-4-5");
  assert.equal(CLAUDE_MODEL_CHOICES[0].id, "", "automatic is first, so it is the default");

  // Wired: one picker and one save; every Claude call asks which model; the DAX picker shows only when it isn't a duplicate.
  const rows = readFileSync("src/components/settings/WorkspaceIntegrationRows.tsx", "utf8");
  assert.match(rows, /action=\{saveAiModel\}/);
  assert.match(rows, /<optgroup key=\{provider\.id\} label=\{provider\.label\}>/);
  assert.match(rows, /chatGpt\.state === "connected" && aiChosen === "claude" && \(/);
  const action = readFileSync("src/app/actions/aiModel.ts", "utf8");
  assert.match(action, /const user = await requireTenantOwner\(\);[\s\S]*parseAiModelChoice\([\s\S]*if \(!choice\) refuse\(/);
  // Jobs someone asks for take the chosen model; quick and automatic jobs keep their cheap one (aiResearchCost.test).
  assert.match(readFileSync("src/lib/aiText.ts", "utf8"), /if \(!input\.quick\) model = await claudeModel\(model\);\s+return await askClaude\(input, model\);/);
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
  assert.match(aiFailureText("not_configured", "x"), /connect ChatGPT or add a Claude key/);
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { aiFailureText, chatTranscript, isOutOfCredit, pickAiProvider } from "../src/lib/aiProviderRules";

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

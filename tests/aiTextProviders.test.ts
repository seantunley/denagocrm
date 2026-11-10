import assert from "node:assert/strict";
import { test } from "node:test";
import Module from "node:module";
import { parseCodexStream } from "../src/lib/codexProtocol";

/*
 * Review of #1056: with ChatGPT the default, a screening record must name the model that ANSWERED (not Claude's by
 * default) and carry ChatGPT's token counts; and aiText must never throw — even when the provider lookup does.
 * aiText and the classifier run here against stand-in providers.
 */

const state = {
  provider: "chatgpt" as string | null,
  settingThrows: false,
  codexReply: {} as Record<string, unknown>,
  claudeJson: {} as Record<string, unknown>,
  claudeStatus: 200,
  metered: [] as unknown[],
};

type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleWithLoad = Module as unknown as { _load: Loader };
const realLoad = moduleWithLoad._load;
moduleWithLoad._load = function (request, parent, isMain) {
  if (request === "server-only") return {};
  if (request === "./settings") {
    return {
      getSetting: async () => {
        if (state.settingThrows) throw new Error("database down");
        return state.provider;
      },
      getProviderKey: async () => "sk-test",
    };
  }
  if (request === "./codex") {
    return { isCodexConnected: async () => true, codexRespond: async () => state.codexReply };
  }
  if (request === "./systemHealth") return { recordAiUsage: async (usage: unknown) => { state.metered.push(usage); } };
  if (request === "./errorLog") return { logError: async () => {} };
  return realLoad.call(this, request, parent, isMain);
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (!String(input).includes("api.anthropic.com")) return realFetch(input as RequestInfo, init);
  return new Response(JSON.stringify(state.claudeJson), { status: state.claudeStatus, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { aiText } = require("../src/lib/aiText") as typeof import("../src/lib/aiText");
const ask = () => aiText({ scope: "test", system: "s", prompt: "p", maxTokens: 50, timeoutMs: 1000, claudeModel: "claude-haiku-4-5", quick: true });

test("ChatGPT: the model that answered and its token counts come back", async () => {
  state.provider = null; // unset = ChatGPT
  state.codexReply = { text: '{"x":1}', incomplete: false, usage: { inputTokens: 410, cachedTokens: 0, outputTokens: 22 }, model: "gpt-5.6-terra" };
  const answer = await ask();
  assert.equal(answer.ok, true);
  assert.ok(answer.ok);
  assert.equal(answer.provider, "chatgpt");
  assert.equal(answer.model, "gpt-5.6-terra", "the model that replied, not the one asked for");
  assert.deepEqual(answer.usage, { input_tokens: 410, output_tokens: 22 });
});

test("ChatGPT failure: the model asked for is named, never Claude's", async () => {
  state.codexReply = { error: "ChatGPT is unavailable or over its usage limit (429).", transient: true };
  const answer = await ask();
  assert.equal(answer.ok, false);
  assert.equal(answer.model, "gpt-6-astra");
  assert.equal(answer.provider, "chatgpt");
});

test("Claude chosen: Claude's own model name and usage, metered", async () => {
  state.provider = "claude";
  state.claudeStatus = 200;
  state.claudeJson = { model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "{}" }], usage: { input_tokens: 300, output_tokens: 12 } };
  state.metered = [];
  const answer = await ask();
  assert.ok(answer.ok);
  assert.equal(answer.provider, "claude");
  assert.equal(answer.model, "claude-haiku-4-5-20251001");
  assert.deepEqual(answer.usage, { input_tokens: 300, output_tokens: 12 });
  assert.equal(state.metered.length, 1);
});

test("Claude out of credit is its own failure", async () => {
  state.claudeStatus = 400;
  state.claudeJson = { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } };
  const answer = await ask();
  assert.equal(answer.ok, false);
  assert.ok(!answer.ok && answer.failure === "no_credit");
});

test("never throws: a provider lookup that throws is a named failure", async () => {
  state.settingThrows = true;
  const answer = await ask();
  state.settingThrows = false;
  assert.equal(answer.ok, false);
  assert.ok(!answer.ok && answer.failure === "unreachable");
});

test("the classifier records the answering model and ChatGPT's tokens", async () => {
  state.provider = null;
  state.codexReply = {
    text: '{"classification":"spam","reasonCodes":["phishing"],"uncertain":false}',
    incomplete: false,
    usage: { inputTokens: 520, cachedTokens: 0, outputTokens: 18 },
    model: "gpt-6-astra",
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { classifyInbound } = require("../src/lib/inboundScreening/classify") as typeof import("../src/lib/inboundScreening/classify");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DEFAULT_POLICY } = require("../src/lib/inboundScreening/rules") as typeof import("../src/lib/inboundScreening/rules");
  const result = await classifyInbound({ channel: "whatsapp", text: "Your account is suspended, send the code", history: [], knownContact: false }, DEFAULT_POLICY);
  assert.equal(result.model, "gpt-6-astra");
  assert.ok(result.ok, "the verdict parsed");
  assert.equal(result.inputTokens, 520);
  assert.equal(result.outputTokens, 18);
});

test("ChatGPT's stream reports output tokens when it has them", () => {
  const stream = 'data: {"type":"response.completed","response":{"output":[],"usage":{"input_tokens":100,"output_tokens":7,"input_tokens_details":{"cached_tokens":40}}}}';
  assert.deepEqual(parseCodexStream(stream).usage, { inputTokens: 100, cachedTokens: 40, outputTokens: 7 });
});

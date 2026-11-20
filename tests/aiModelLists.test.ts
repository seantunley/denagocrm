import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chatGptChoicesFrom, claudeChoicesFrom } from "../src/lib/aiModelLists";
import { CODEX_DEFAULT_MODEL } from "../src/lib/codexProtocol";

// Sean, 2026-11-20 (from Scarlet): the picker lists what each provider offers, asked of the provider, instead of a
// hand-kept list that goes stale.

const claude = (id: string, line: string | null, created: string, lifecycle = "active") => ({
  type: "model", id, display_name: id.replace("claude-", "Claude ").replace(/-/g, " "), line, created_at: created, lifecycle,
});

test("Claude: the newest active model of each line, cheapest line first; restricted lines are not offered", () => {
  const data = [
    claude("claude-opus-5", "opus", "2026-03-01"),
    claude("claude-opus-5-5", "opus", "2026-09-01"),
    claude("claude-haiku-5-5", "haiku", "2026-08-01"),
    claude("claude-sonnet-6", "sonnet", "2026-11-01"),
    claude("claude-sonnet-5-5", "sonnet", "2026-08-01"),
    claude("claude-opus-6", "opus", "2026-11-10", "deprecated"),
    claude("claude-mythos-5-1", "mythos", "2026-10-01"),
    { id: "not-a-claude-id", display_name: "x", line: "opus", lifecycle: "active", created_at: "2027-01-01" },
  ];
  assert.deepEqual(claudeChoicesFrom(data, "")?.map((c) => c.id), ["claude-haiku-5-5", "claude-sonnet-6", "claude-opus-5-5"]);
  assert.match(claudeChoicesFrom(data, "")![0].label, /quickest, lowest cost/);
});

test("Claude: the saved model is always shown, marked when Anthropic is retiring or has dropped it", () => {
  const data = [claude("claude-opus-5-5", "opus", "2026-09-01"), claude("claude-opus-4-8", "opus", "2026-05-01", "deprecated"), claude("claude-sonnet-5", "sonnet", "2026-03-01")];
  assert.equal(claudeChoicesFrom(data, "claude-opus-4-8")?.at(-1)?.label, "Claude opus 4 8 — being retired by Anthropic");
  assert.equal(claudeChoicesFrom(data, "claude-opus-4-1")?.at(-1)?.label, "claude-opus-4-1 — no longer offered");
  assert.equal(claudeChoicesFrom(data, "claude-sonnet-5")?.length, 2, "an active one already listed is not repeated");
  for (const bad of [null, {}, "x", []]) assert.equal(claudeChoicesFrom(bad, ""), null, "nothing usable: the built-in list");
});

test("ChatGPT: the models it lists, in its order; hidden ones left out; the saved one always shown", () => {
  const models = [
    { slug: "gpt-6-astra", visibility: "list", priority: 3 },
    { slug: CODEX_DEFAULT_MODEL, visibility: "list", priority: 1 },
    { slug: "gpt-6-internal", visibility: "hide", priority: 0 },
    { slug: "codex-auto-review", visibility: "none", priority: 0 },
    { slug: "bad slug; rm", visibility: "list", priority: 2 },
  ];
  const choices = chatGptChoicesFrom(models, "gpt-5.4")!;
  assert.deepEqual(choices.map((c) => c.id), [CODEX_DEFAULT_MODEL, "gpt-6-astra", "gpt-5.4"]);
  assert.equal(choices[0].label, `${CODEX_DEFAULT_MODEL} (recommended)`);
  assert.equal(choices[2].label, "gpt-5.4 — not offered by ChatGPT now");
  for (const bad of [null, {}, [], [{ slug: "x", visibility: "hide" }]]) assert.equal(chatGptChoicesFrom(bad, ""), null);
});

test("wired: the lists are asked of the providers with no token write, and fall back to the built-in lists", () => {
  const codex = readFileSync("src/lib/codex.ts", "utf8");
  const listFn = codex.slice(codex.indexOf("export async function codexModelList"), codex.indexOf("export type CodexStatus"));
  assert.match(listFn, /if \(!tokens \|\| needsRefresh\(tokens\)\) return null;/);
  assert.doesNotMatch(listFn, /accessToken\(|putSetting/, "never renews the sign-in while a page renders");
  const catalog = readFileSync("src/lib/aiModelCatalog.ts", "utf8");
  assert.match(catalog, /https:\/\/api\.anthropic\.com\/v1\/models\?limit=1000/);
  assert.match(catalog, /chatgpt: chatgpt \?\? modelChoices\(current\.chatgpt\)/);
  assert.match(catalog, /claude: \[CLAUDE_MODEL_CHOICES\[0\], \.\.\.\(claude \?\? builtInClaude\)\]/);
});

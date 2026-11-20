import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chatGptChoicesFrom, claudeChoicesFrom } from "../src/lib/aiModelLists";
import { claudeModelFor, parseAiModelChoice } from "../src/lib/aiProviderRules";
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
  // The newest PRICED active model per line is offered; a newer unpriced one (claude-sonnet-6, not in the price file)
  // is listed beside it, disabled (review of #1154).
  const choices = claudeChoicesFrom(data, "")!;
  assert.deepEqual(choices.filter((c) => !c.disabled).map((c) => c.id), ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
  assert.deepEqual(choices.filter((c) => c.disabled).map((c) => c.id), ["claude-sonnet-6"]);
  assert.match(choices[0].label, /quickest, lowest cost/);
});

test("Claude: the saved model is always shown, marked when Anthropic is retiring or has dropped it", () => {
  const data = [claude("claude-opus-5-5", "opus", "2026-09-01"), claude("claude-opus-4-8", "opus", "2026-05-01", "deprecated"), claude("claude-sonnet-5", "sonnet", "2026-03-01")];
  assert.equal(claudeChoicesFrom(data, "claude-opus-4-8")?.at(-1)?.label, "Claude opus 4 8 — being retired by Anthropic");
  // Priced, but Anthropic no longer lists it.
  assert.equal(claudeChoicesFrom(data, "claude-opus-4-5")?.at(-1)?.label, "claude-opus-4-5 — no longer offered");
  assert.equal(claudeChoicesFrom(data, "claude-sonnet-5")?.length, 2, "an active one already listed is not repeated");
  for (const bad of [null, {}, "x", []]) assert.equal(claudeChoicesFrom(bad, ""), null, "nothing usable: the built-in list");
});

// Review of #1154: a live Claude model the billing price list doesn't have yet must never be switched on — it would
// spend Anthropic credit the meter can't price. Shown "price pending", disabled; the priced one stays offered.
test("Claude: a new model with no listed price is shown 'price pending' and can't be chosen — saved or offered", () => {
  const data = [claude("claude-haiku-6", "haiku", "2026-11-19"), claude("claude-haiku-5-5", "haiku", "2026-08-01"), claude("claude-sonnet-5-5", "sonnet", "2026-08-01")];
  const choices = claudeChoicesFrom(data, "")!;
  assert.deepEqual(choices.find((c) => c.id === "claude-haiku-5-5"), { id: "claude-haiku-5-5", label: "Claude haiku 5 5 — quickest, lowest cost" }, "the newest PRICED Haiku is the one offered");
  const pending = choices.find((c) => c.id === "claude-haiku-6")!;
  assert.equal(pending.disabled, true);
  assert.match(pending.label, /price pending/);

  // Saved before its price was known: shown, disabled, says what happens meanwhile — and never used.
  const saved = claudeChoicesFrom([claude("claude-haiku-5-5", "haiku", "2026-08-01")], "claude-sonnet-9")!.at(-1)!;
  assert.equal(saved.disabled, true);
  assert.match(saved.label, /price pending[\s\S]*; your jobs use their own models meanwhile/);
  assert.equal(claudeModelFor("claude-sonnet-9", "claude-haiku-4-5"), "claude-haiku-4-5", "an unpriced saved model is not used");
  assert.equal(claudeModelFor("claude-sonnet-5-5", "claude-haiku-4-5"), "claude-sonnet-5-5");

  // Server side: refused even if the browser sends it as if it were on offer.
  assert.equal(parseAiModelChoice("claude:claude-haiku-6", [], ["claude-haiku-6"]), null);
  assert.deepEqual(parseAiModelChoice("claude:claude-haiku-5-5", [], ["claude-haiku-5-5"]), { provider: "claude", model: "claude-haiku-5-5" });
  const action = readFileSync("src/app/actions/aiModel.ts", "utf8");
  assert.match(action, /list\.filter\(\(item\) => !item\.disabled\)/);
  assert.match(action, /has no listed price yet, so it can't be switched on/);
  assert.match(readFileSync("src/components/settings/WorkspaceIntegrationRows.tsx", "utf8"), /disabled=\{choice\.disabled\}/);
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

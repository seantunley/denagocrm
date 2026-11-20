/**
 * The model lists in Settings → Integrations, as the providers themselves list them (Sean, 2026-11-20, from Scarlet:
 * ask each provider for its models instead of keeping the list by hand). Pure, so it can be tested without a network;
 * the requests are in lib/aiModelCatalog.ts.
 */
import { CODEX_DEFAULT_MODEL } from "./codexProtocol";
import { CLAUDE_MODEL_ID } from "./aiProviderRules";
import { hasListedPrice } from "./usageMeters";

/** disabled: shown, but it can't be chosen — a Claude model with no listed price yet (review of #1154). */
export type ModelChoice = { id: string; label: string; disabled?: true };

/** Shown for a Claude model the price list doesn't have yet: visible, never selectable, and what happens meanwhile. */
const PRICE_PENDING = "price pending — not available until the weekly price update lists it";

/** Cheapest line first. A line not named here (a restricted one) is not offered. */
const CLAUDE_LINES = [
  ["haiku", "quickest, lowest cost"],
  ["sonnet", "balanced"],
  ["opus", "strong, higher cost"],
  ["fable", "most capable, highest cost"],
] as const;

type ClaudeModel = { id: string; display_name: string; lifecycle?: string; line?: string | null; created_at?: string };

/**
 * Anthropic's GET /v1/models `data` → per line, the newest active model WITH A LISTED PRICE (review of #1154: a model
 * the billing meter can't price must never be switched on). A newer one still waiting for its price is shown beside it,
 * disabled, "price pending". The saved model is always shown, so the page never misreports what is in use — disabled,
 * with the reason, when it has no listed price. null when the answer holds nothing usable (the built-in list is used).
 */
export function claudeChoicesFrom(data: unknown, current: string): ModelChoice[] | null {
  if (!Array.isArray(data)) return null;
  const models = data.filter(
    (m): m is ClaudeModel => typeof m?.id === "string" && CLAUDE_MODEL_ID.test(m.id) && typeof m.display_name === "string",
  );
  const newestFirst = (a: ClaudeModel, b: ClaudeModel) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""));
  const choices: ModelChoice[] = [];
  for (const [line, hint] of CLAUDE_LINES) {
    const active = models.filter((m) => m.line === line && m.lifecycle === "active").sort(newestFirst);
    const priced = active.find((m) => hasListedPrice(m.id));
    if (priced) choices.push({ id: priced.id, label: `${priced.display_name} — ${hint}` });
    const pending = active[0] && !hasListedPrice(active[0].id) ? active[0] : null;
    if (pending) choices.push({ id: pending.id, label: `${pending.display_name} — ${PRICE_PENDING}`, disabled: true });
  }
  if (!choices.some((choice) => !choice.disabled)) return null;
  if (current && !choices.some((choice) => choice.id === current)) {
    const saved = models.find((m) => m.id === current);
    const name = saved?.display_name ?? current;
    if (!hasListedPrice(current)) choices.push({ id: current, label: `${name} — ${PRICE_PENDING}; your jobs use their own models meanwhile`, disabled: true });
    else choices.push({ id: current, label: !saved ? `${current} — no longer offered` : saved.lifecycle === "active" ? saved.display_name : `${saved.display_name} — being retired by Anthropic` });
  }
  return choices;
}

const CHATGPT_MODEL_ID = /^[a-z0-9][a-z0-9._-]*$/i;

type ChatGptModel = { slug: string; visibility?: string; priority?: number };

/**
 * The ChatGPT backend's /models `models` (what the Codex app's own picker shows) → the models it lists, in its order.
 * The saved model is always shown. null when the answer holds nothing usable (the built-in list is used).
 */
export function chatGptChoicesFrom(models: unknown, current: string): ModelChoice[] | null {
  if (!Array.isArray(models)) return null;
  const listed = models
    .filter((m): m is ChatGptModel => typeof m?.slug === "string" && CHATGPT_MODEL_ID.test(m.slug) && m.visibility === "list")
    .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0));
  if (!listed.length) return null;
  const choices = listed.map((m) => ({ id: m.slug, label: `${m.slug}${m.slug === CODEX_DEFAULT_MODEL ? " (recommended)" : ""}` }));
  if (current && !choices.some((choice) => choice.id === current)) choices.push({ id: current, label: `${current} — not offered by ChatGPT now` });
  return choices;
}

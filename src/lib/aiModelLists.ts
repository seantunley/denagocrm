/**
 * The model lists in Settings → Integrations, as the providers themselves list them (Sean, 2026-11-20, from Scarlet:
 * ask each provider for its models instead of keeping the list by hand). Pure, so it can be tested without a network;
 * the requests are in lib/aiModelCatalog.ts.
 */
import { CODEX_DEFAULT_MODEL } from "./codexProtocol";
import { CLAUDE_MODEL_ID } from "./aiProviderRules";

export type ModelChoice = { id: string; label: string };

/** Cheapest line first. A line not named here (a restricted one) is not offered. */
const CLAUDE_LINES = [
  ["haiku", "quickest, lowest cost"],
  ["sonnet", "balanced"],
  ["opus", "strong, higher cost"],
  ["fable", "most capable, highest cost"],
] as const;

type ClaudeModel = { id: string; display_name: string; lifecycle?: string; line?: string | null; created_at?: string };

/**
 * Anthropic's GET /v1/models `data` → the newest active model of each line. The saved model is always shown, so the
 * page never misreports what is in use. null when the answer holds nothing usable (the built-in list is used).
 */
export function claudeChoicesFrom(data: unknown, current: string): ModelChoice[] | null {
  if (!Array.isArray(data)) return null;
  const models = data.filter(
    (m): m is ClaudeModel => typeof m?.id === "string" && CLAUDE_MODEL_ID.test(m.id) && typeof m.display_name === "string",
  );
  const choices: ModelChoice[] = [];
  for (const [line, hint] of CLAUDE_LINES) {
    const newest = models
      .filter((m) => m.line === line && m.lifecycle === "active")
      .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))[0];
    if (newest) choices.push({ id: newest.id, label: `${newest.display_name} — ${hint}` });
  }
  if (!choices.length) return null;
  if (current && !choices.some((choice) => choice.id === current)) {
    const saved = models.find((m) => m.id === current);
    const label = !saved ? `${current} — no longer offered` : saved.lifecycle === "active" ? saved.display_name : `${saved.display_name} — being retired by Anthropic`;
    choices.push({ id: current, label });
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

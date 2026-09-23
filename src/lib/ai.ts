import { getSetting } from "./settings";
import { prisma } from "./db";
import { logError } from "./errorLog";
import { recordAiUsage } from "./systemHealth";
import { inheritedTenantId } from "./tenantWrite";
import { codexRespond, isCodexConnected } from "./codex";
import {
  CHATGPT_RESEARCH_FORMAT_NOTE,
  RESEARCH_INSTRUCTIONS,
  corporateDomain,
  researchLeadMessage,
  stripInlineCitations,
} from "./researchPrompt";
import type { CronSliceContext } from "./tenantCron";

export async function isAiConfigured(): Promise<boolean> {
  return Boolean(await getSetting("ANTHROPIC_API_KEY"));
}

/**
 * Proofreads an outbound draft: SA-English spelling, wrong names, suspect
 * numbers, missing attachments. Returns a short list of issues or [].
 * Suggestions only — nothing is ever auto-corrected.
 */
export async function aiCheckDraft(input: {
  draft: string;
  customerName?: string | null;
  context?: string | null;
}): Promise<{ issues: string[] } | { error: string }> {
  const apiKey = await getSetting("ANTHROPIC_API_KEY");
  if (!apiKey) return { error: "AI Assist is not configured (Settings → Integrations)." };

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(20000),
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 500,
        system:
          "You proofread short outbound messages for Denago Cape Town, a South African electric golf-cart dealership. Check ONLY for: spelling/grammar errors (South African English), the customer's name spelled differently from the record, numbers or prices that look mistyped, references to attachments when none are mentioned as attached, and accidentally unprofessional tone. Respond with STRICT JSON: {\"issues\": [\"...\"]} — each issue one short sentence. If the message is fine, respond {\"issues\": []}. Never rewrite the message, never invent issues.",
        messages: [
          {
            role: "user",
            content: `Customer on record: ${input.customerName ?? "(unknown)"}\n${
              input.context ? `Context: ${input.context}\n` : ""
            }\nDraft message:\n"""\n${input.draft.slice(0, 3000)}\n"""`,
          },
        ],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      await logError("ai-check", `Anthropic API ${res.status}`, text.slice(0, 300));
      return { error: `AI check failed (${res.status}).` };
    }
    const json = await res.json();
    void recordAiUsage(json.usage);
    const content: string = json.content?.[0]?.text ?? "{}";
    const match = content.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : "{}");
    return { issues: Array.isArray(parsed.issues) ? parsed.issues.slice(0, 8) : [] };
  } catch (err) {
    await logError("ai-check", err);
    return { error: "AI check failed — logged in the System Log." };
  }
}

/**
 * HubSpot-style enrichment: given a name + email, Claude searches the web and
 * returns a short synopsis of the company (from the domain) and, where
 * findable, the person. Uses the bigger model + web search — pennies per
 * lookup, run on demand only.
 *
 * Directs the model at LinkedIn and the other social platforms explicitly,
 * same shape as discoverSources() in competitors.ts (the codebase's other
 * web-search research path). Left to a generic "search the web" instruction,
 * the model didn't reliably check LinkedIn for a person's current role, and
 * even when it found a clear, direct answer it still hedged ("might be tied
 * to X") — the prompt now tells it to state a directly-sourced fact as fact,
 * and reserve hedging for genuinely weak or ambiguous evidence.
 *
 * max_uses raised from 4 to 8 (matching discoverSources' maxUses: 8) — four
 * searches wasn't enough room for a company search, a LinkedIn search for the
 * person, and a confirming pass. Timeout raised to match (90s is the existing
 * budget discoverSources already runs its 8-search pass inside on this
 * platform).
 *
 * The briefing is now three labeled lines (Company:/Role:/Fit:) instead of
 * free prose, so the UI can render it as a structured card (see
 * ResearchBriefing.tsx) instead of one undifferentiated paragraph. Every
 * caller still just stores `summary` as-is — parsing is done at RENDER time,
 * tolerantly (unlabeled text, including every note written before this
 * change, falls back to a plain paragraph), so this needed no migration and
 * no backfill.
 */
/**
 * Backstop on a runaway briefing — NOT the length budget.
 *
 * This used to be `summary.slice(0, 2000)`, which was invisible while briefings
 * were one terse line each and started cutting the moment they became thorough:
 * a real note ended "…appointed alternate directors of Shopr", mid-word, with
 * the entire `Fit:` line gone. Nothing logged it, because slicing a string
 * cannot fail.
 *
 * `Contact.research` and `ResearchNote.body` are unbounded Postgres text, so
 * 2000 was never protecting anything. The ceiling now sits well above what a
 * thorough briefing runs to, and cuts on a LINE boundary when it is reached —
 * losing a whole labelled section is legible, losing half a word is not.
 */
const MAX_SUMMARY_CHARS = 12000;

function capSummary(summary: string): string {
  if (summary.length <= MAX_SUMMARY_CHARS) return summary;
  const kept: string[] = [];
  let used = 0;
  for (const line of summary.split("\n")) {
    if (used + line.length + 1 > MAX_SUMMARY_CHARS) break;
    kept.push(line);
    used += line.length + 1;
  }
  // A single line longer than the whole ceiling still has to be cut somewhere;
  // prefer the last space so it ends on a word.
  if (kept.length === 0) {
    const hard = summary.slice(0, MAX_SUMMARY_CHARS);
    const lastSpace = hard.lastIndexOf(" ");
    return (lastSpace > MAX_SUMMARY_CHARS * 0.8 ? hard.slice(0, lastSpace) : hard).trim() + "…";
  }
  return kept.join("\n").trim();
}

/**
 * What an AUTOMATIC research run costs, as opposed to one somebody clicked for.
 *
 * September's own ledger (AI_TOKENS_2026-09) put a research call at ~144,000
 * input tokens: the web-search results are read into context, and every extra
 * search adds pages. On Opus 5 that is the most expensive call this app makes,
 * and the scheduled sweep made it for every new lead — spam included — without
 * anybody asking. Haiku reads the same pages at a fraction of the price, and
 * three searches find the company and the LinkedIn profile, which is what the
 * card actually shows. A salesperson who wants the deep version presses
 * Research on the lead and gets Opus with the full search budget.
 */
export const AUTO_RESEARCH_MODEL = "claude-haiku-4-5";

/**
 * How much of a cron tick must be left to start another lead. A ChatGPT
 * research call measured up to ~80 seconds; this leaves room for the slowest
 * plus the writes after it.
 */
export const AUTO_RESEARCH_RESERVE_MS = 120_000;
export const AUTO_RESEARCH_MAX_SEARCHES = 3;

export type ResearchResult =
  | { summary: string }
  | {
      error: string;
      /**
       * The failure was the API's, not the lead's: out of credit, rate-limited,
       * or overloaded. The next call will fail the same way for every lead, so
       * a sweep should STOP rather than work down the list — and the lead has
       * not been researched, so it should not lose its turn.
       */
      transient?: true;
    };

/**
 * DROP THE NARRATION THE PROMPT ALREADY FORBIDS.
 *
 * The prompt says "no preamble" and models write one anyway — "I'll research
 * this lead across multiple angles." — as their own text. It is a documented
 * habit, not a prompt bug, so it is handled here rather than argued with in the
 * system prompt. Shared by both research providers, so a ChatGPT briefing and an
 * Anthropic one land in the same card.
 *
 * It has to be stripped, not tolerated: joined with "" the preamble is glued
 * directly onto the first label ("...multiple angles.Company: ...") so NO line
 * matches a label, ResearchBriefing drops to its verbatim fallback, and the whole
 * briefing renders as one undifferentiated wall instead of the Company/Role/Fit
 * card. One stray sentence costs the card.
 *
 * Only ever cuts a PREFIX, and only when a label exists after it, so a briefing
 * with no labels at all ("No reliable information found.") is left exactly as
 * written.
 */
async function stripResearchPreamble(summary: string): Promise<string> {
  const labelStart = summary.search(/(?:Company|Role|Fit):/i);
  if (labelStart <= 0) return summary;
  // LOGGED ONLY WHEN IT IS BIG ENOUGH TO BE RESEARCH RATHER THAN NARRATION.
  //
  // A one-line "I'll research this lead…" prefix is on most calls, so logging
  // every strip would file a row per research run and bury real errors in the
  // System Log. A LONG prefix means this is cutting actual prose, and that is
  // worth a row precisely because the discarded text is gone from the note.
  if (labelStart > 200) {
    await logError(
      "ai-research",
      "Discarded a long prefix before the first label",
      `${labelStart} chars dropped: ${summary.slice(0, 160)}…`,
    );
  }
  return summary.slice(labelStart).trim();
}

/** Research can run: on a connected ChatGPT subscription, or on the Anthropic key. */
export async function isResearchConfigured(): Promise<boolean> {
  return (await isCodexConnected()) || (await isAiConfigured());
}

export async function aiResearch(
  input: {
    name: string;
    email?: string | null;
  },
  options: { model?: string; maxSearches?: number } = {},
): Promise<ResearchResult> {
  // A workspace that has connected its ChatGPT subscription researches on that
  // instead of pay-per-token Anthropic credit (lib/codex.ts). There is
  // deliberately NO fallback to Anthropic when ChatGPT fails: the point of
  // connecting it is that research stops spending API credit, and a silent
  // fallback would bring the bill straight back without anyone choosing it.
  const useChatGpt = await isCodexConnected();
  const apiKey = useChatGpt ? null : await getSetting("ANTHROPIC_API_KEY");
  if (!useChatGpt && !apiKey) {
    return { error: "AI Assist is not configured (Settings → Integrations)." };
  }
  const corporate = corporateDomain(input.email);

  /**
   * SERVER-SIDE WEB SEARCH DOES NOT ALWAYS FINISH IN ONE RESPONSE.
   *
   * With `max_uses: 8` the model runs a multi-step search, and the API may end a
   * response with `stop_reason: "pause_turn"` — the turn is incomplete, the
   * content so far is `server_tool_use` / `web_search_tool_result` blocks, and
   * there is NO text block yet. The documented continuation is to send the
   * conversation back with that assistant turn appended so the model resumes.
   *
   * We did not. We read "no text block" as failure and showed the user "No
   * usable research came back", discarding a search that was simply mid-flight.
   * That is why research regressed when the search tool was added: the old
   * single-shot call always returned text in one response, so the case never
   * arose.
   *
   * `messages` therefore grows as the turn continues, rather than being rebuilt.
   */
  const messages: { role: string; content: unknown }[] = [];
  let stopReason: string | null = null;

  const callApi = async (body: unknown) =>
    fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(90000),
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

  try {
    const requestBody = {
        model: options.model ?? "claude-opus-5",
        // MAX_TOKENS IS SHARED WITH THE SEARCH, WHICH IS WHY 700 PRODUCED STUBS.
        //
        // The model's `server_tool_use` blocks — one per web search, up to
        // `max_uses` of them — are OUTPUT tokens and come out of this budget
        // before a single word of prose is written. At 700 with eight searches
        // there was almost nothing left: the briefing arrived truncated
        // mid-sentence ("...several people named X in South") and the `Fit:` line
        // never got written at all. Adaptive thinking, which is on by default on
        // this model, is billed against the same ceiling.
        //
        // 16000 is the standard non-streaming ceiling — high enough that the
        // budget is never the binding constraint, and it costs nothing when
        // unused because output is billed on what is actually produced.
        max_tokens: 16000,
        // DELIBERATELY THE BASIC SEARCH TOOL, NOT `_20260209`.
        //
        // The `_20260209` variant filters results in a code sandbox before they
        // reach the context, which sounds strictly better and measured worse
        // here: the model spent its turn writing Python to probe the result
        // shape (`print(type(r))`), burned three rounds on the harness, and then
        // answered "No reliable information found." while holding 29 results.
        // This task needs the model to READ a handful of pages and synthesise
        // them, and the basic tool puts them straight into context where it can.
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: options.maxSearches ?? 8 }],
        system: RESEARCH_INSTRUCTIONS,
    };

    // The opening turn. It lives in `messages` — NOT in `requestBody` — because
    // every call spreads `{ ...requestBody, messages }`, so a copy left behind in
    // the body would be silently replaced by this array and the continuation
    // would resend a conversation the prompt had fallen out of.
    messages.push({ role: "user", content: researchLeadMessage(input.name, input.email) });
    // Bounded: a paused turn is resumed at most this many times. The cap exists
    // so a model that keeps pausing cannot spin — and each pass carries the same
    // 90s timeout, so the ceiling is wall-clock as well as count.
    const MAX_CONTINUATIONS = 4;
    let summary = "";

    if (useChatGpt) {
      // Same prompt, same briefing format, same checks after — only the
      // transport differs. The search budget is an Anthropic tool parameter
      // with no Responses equivalent; on a flat-rate plan it is also not the
      // cost it is on the API.
      // HIGH REASONING, LONG ANSWERS, ON THE BEST MODEL. On a flat-rate plan
      // there is no per-call cost to economise on, and the defaults showed:
      // the first ChatGPT briefing on the Petrow Agri lead was two thin
      // sentences a label beside an Opus note that named the directors. Sol at
      // high effort, with the registry angle in the prompt, found them too —
      // at 50 to 80 seconds a call, which is why the timeout is generous and
      // automatic research has its own cron route.
      const reply = await codexRespond({
        instructions: RESEARCH_INSTRUCTIONS + CHATGPT_RESEARCH_FORMAT_NOTE,
        prompt: String(messages[0].content),
        webSearch: true,
        reasoningEffort: "high",
        verbosity: "high",
        timeoutMs: 150_000,
      });
      if ("error" in reply) {
        return reply.transient ? { error: reply.error, transient: true } : { error: reply.error };
      }
      // Its search writes inline citation links into the prose, which the card
      // shows as raw text. The prompt asks it not to; this makes sure.
      summary = await stripResearchPreamble(stripInlineCitations(reply.text));
      stopReason = reply.incomplete ? "max_tokens" : "end_turn";
    }

    for (let attempt = 0; !useChatGpt && attempt <= MAX_CONTINUATIONS; attempt++) {
      const res = await callApi({ ...requestBody, messages });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        await logError("ai-research", `Anthropic API ${res.status}`, text.slice(0, 300));
        // Out of credit arrives as a 400 invalid_request_error, not a 402, so
        // the status alone cannot tell it apart from a malformed request.
        const transient =
          res.status === 429 || res.status >= 500 || /credit balance/i.test(text);
        return transient
          ? { error: `Research failed (${res.status}).`, transient: true }
          : { error: `Research failed (${res.status}).` };
      }
      const json = await res.json();
      void recordAiUsage(json.usage);
      stopReason = json.stop_reason ?? null;

      // JOINED WITH "", NOT "\n" — THE BLOCKS ARE ONE SENTENCE, NOT ONE LINE EACH.
      //
      // Web search returns CITED text, so the model's prose arrives split at every
      // citation boundary: `"…joined the Shoprite Group in 2001"`, `", having
      // earlier "`, `"worked at Compaq in London"`. Joining those with a newline
      // inserts a line break mid-sentence — measured on a real response, one
      // three-line briefing became FORTY-THREE lines.
      //
      // That is not cosmetic. ResearchBriefing only renders its Company/Role/Fit
      // card when EVERY line matches a label, so the fragments dropped it to the
      // verbatim fallback and displayed prose shredded mid-clause. Same response,
      // joined with "": 3 lines, card renders.
      summary = (json.content ?? [])
        .filter((b: { type: string }) => b.type === "text")
        .map((b: { text: string }) => b.text)
        .join("")
        .trim();

      summary = await stripResearchPreamble(summary);

      // Only a paused turn is worth resuming. Any other stop_reason means the
      // model is done and whatever text exists is the answer.
      if (stopReason !== "pause_turn") break;

      // Resume by appending the assistant turn verbatim — the search results it
      // already gathered are IN that content, so rebuilding or trimming it would
      // throw away the work the pause exists to preserve.
      messages.push({ role: "assistant", content: json.content });
    }

    // A TRUNCATED BRIEFING IS NOT A BRIEFING, and it used to be saved as one.
    //
    // The empty-summary branch below already knew about `max_tokens` and said so
    // in its log. It just never ran for the case that actually happened: the
    // model wrote SOME prose and was cut off mid-sentence, so `summary` was
    // non-empty, the loop broke on a non-`pause_turn` stop reason, and the stub
    // was filed to the timeline as finished research. Nothing logged, nothing
    // flagged — the note simply read as though that was all there was to find.
    //
    // Fail loudly instead. A person can re-run Research; they cannot tell a
    // truncated note from a complete one weeks later.
    if (stopReason === "max_tokens") {
      await logError(
        "ai-research",
        "Research truncated at max_tokens",
        `Wrote ${summary.length} chars before the ceiling. Raise max_tokens or lower max_uses.`,
      );
      return { error: "Research was cut off before it finished — nothing was saved. Try again." };
    }

    if (!summary) {
      // This used to return silently, which is why a live regression left no
      // trace: the System Log had nothing, so there was no way to tell a paused
      // turn from an empty one. stop_reason is the whole diagnosis.
      await logError(
        "ai-research",
        `No text block in response (stop_reason=${stopReason ?? "unknown"})`,
        stopReason === "pause_turn"
          ? `Still paused after ${MAX_CONTINUATIONS} continuations — the search did not converge.`
          : stopReason === "max_tokens"
            ? "max_tokens was consumed by search results before any prose was written; raise max_tokens or lower max_uses."
            : "",
      );
      return { error: "No usable research came back." };
    }
    // A BAIL IS A SUCCESSFUL RESPONSE, WHICH IS EXACTLY WHY IT NEEDS A ROW.
    //
    // "No reliable information found." returns HTTP 200 with a summary, so it is
    // saved and nothing is logged — and that is the shape the 2026-08-13
    // regression took: Research quietly gave up on every lead, and the only way
    // anybody found out was opening a contact and reading the note. There is no
    // error to catch here; the whole point is that the model answered.
    //
    // One row per bail. Bails should be rare — if they are not, that IS the
    // finding, and the System Log is where it should show up.
    if (/^no reliable information found\.?$/i.test(summary.trim())) {
      await logError(
        "ai-research",
        "Research found nothing and bailed",
        `Lead: ${input.name}${corporate ? ` (${corporate})` : " (no corporate domain)"}. ` +
          `stop_reason=${stopReason ?? "unknown"}. Repeated bails mean the prompt or the search is regressing, not that every lead is unknown.`,
      );
    }

    // The cap is a backstop, so reaching it is itself the news: a briefing that
    // long means whole labelled sections were dropped from what gets saved, and
    // the note on screen gives no hint that anything is missing.
    if (summary.length > MAX_SUMMARY_CHARS) {
      await logError(
        "ai-research",
        "Briefing exceeded the summary ceiling and was trimmed",
        `${summary.length} chars trimmed to ${MAX_SUMMARY_CHARS}; trailing labelled sections were dropped.`,
      );
    }
    return { summary: capSummary(summary) };
  } catch (err) {
    await logError("ai-research", err);
    return { error: "Research failed — logged in the System Log." };
  }
}

/**
 * Auto-research: new leads (last 48h) that have an email get ONE briefing
 * attempt, filed automatically. Max 5 per cron run.
 *
 * ONE ATTEMPT, NOT ONE SUCCESS. The sweep used to select leads with no research
 * and `continue` past any failure, so a lead whose research came back empty —
 * which is exactly what a spam lead with a made-up name does — stayed eligible
 * and was researched again on every run for 48 hours. Each retry was a full,
 * paid call. `researchedAt` is now stamped on every attempt that reached the
 * model, and the sweep selects on it, so a lead gets one try. The Research
 * button on the lead still works for a second look.
 *
 * STOP ON THE API'S FAILURE, NOT THE LEAD'S. When the account is out of credit
 * every call fails identically, and working down the list turned that into
 * several hundred logged 400s a day (381 on 7 Sep, 389 on 8 Sep). A transient
 * failure ends the run and leaves the lead unmarked — it has not actually been
 * researched — so the next run picks it up once credit is back.
 *
 * Lost leads are skipped: a lead marked lost within minutes of arriving is
 * usually the spam, and researching it is paying to learn nothing.
 */
export async function runAutoResearch(budget?: Pick<CronSliceContext, "shouldStop">): Promise<number> {
  if ((await getSetting("AI_AUTO_RESEARCH")) !== "true") return 0;
  if (!(await isResearchConfigured())) return 0;
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const leads = await prisma.lead.findMany({
    where: {
      createdAt: { gte: since },
      email: { not: null },
      research: null,
      researchedAt: null,
      status: { not: "lost" },
    },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  let done = 0;
  for (const lead of leads) {
    // Only start a lead there is time to finish. A call cut off by the
    // platform leaves the lead unmarked, so the next tick simply tries it —
    // but it was a wasted call, and on the API a paid one.
    if (budget?.shouldStop(AUTO_RESEARCH_RESERVE_MS)) break;
    const result = await aiResearch(
      { name: lead.name, email: lead.email },
      { model: AUTO_RESEARCH_MODEL, maxSearches: AUTO_RESEARCH_MAX_SEARCHES },
    );
    if ("error" in result) {
      if (result.transient) break;
      // The model ran and found nothing usable. That call was paid for; spend
      // no more on this lead automatically.
      await prisma.lead.update({ where: { id: lead.id }, data: { researchedAt: new Date() } });
      continue;
    }
    const researchedAt = new Date();
    await prisma.researchNote.create({
      // THE LEAD OWNS ITS RESEARCH. This runs on the automations cron, so there
      // is no session at all to resolve an acting workspace from — and the guard
      // stamps nothing while enforcement is dormant, so the note was landing
      // unowned (1 of 23 on production at the 2026-08-10 audit, written after the
      // July backfill). The lead this note is about is the only thing here that
      // knows whose it is.
      data: {
        tenantId: inheritedTenantId(lead.tenantId),
        body: result.summary,
        leadId: lead.id,
        contactId: lead.contactId,
      },
    });
    await prisma.lead.update({
      where: { id: lead.id },
      data: { research: result.summary, researchedAt },
    });
    if (lead.contactId) {
      await prisma.contact.update({
        where: { id: lead.contactId },
        data: { research: result.summary, researchedAt },
      });
    }
    done++;
  }
  return done;
}

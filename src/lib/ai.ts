import { getSetting } from "./settings";
import { prisma } from "./db";
import { logError } from "./errorLog";
import { recordAiUsage } from "./systemHealth";
import { inheritedTenantId } from "./tenantWrite";

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

const FREE_MAIL = new Set([
  "gmail.com","yahoo.com","outlook.com","hotmail.com","icloud.com","live.com",
  "webmail.co.za","mweb.co.za","telkomsa.net","vodamail.co.za","aol.com",
]);

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
export async function aiResearch(input: {
  name: string;
  email?: string | null;
}): Promise<{ summary: string } | { error: string }> {
  const apiKey = await getSetting("ANTHROPIC_API_KEY");
  if (!apiKey) return { error: "AI Assist is not configured (Settings → Integrations)." };
  const domain = input.email?.split("@")[1]?.toLowerCase();
  const corporate = domain && !FREE_MAIL.has(domain) ? domain : null;

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
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

  try {
    const requestBody = {
        model: "claude-opus-5",
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
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
        system:
          "You research sales leads for Denago Cape Town, a South African electric golf-cart dealership.\n\n" +
          "SEARCH HARD BEFORE YOU CONCLUDE ANYTHING. Work several angles, not one or two: the person's name plus LinkedIn, the name plus \"South Africa\", the name plus any employer you turn up, and the company's own website and public social profiles (Facebook, Instagram, X/Twitter). LinkedIn is usually the most reliable source for a current role — search for it directly rather than relying on whatever a generic web search happens to surface. Two searches is not a search.\n\n" +
          // THE OLD PROMPT TALKED ITSELF OUT OF THE ANSWER, AND THIS MODEL OBEYED.
          //
          // It said to research the person "only if confidently identifiable" and
          // offered "No reliable information found." as the out. For a common
          // name that made bailing the COMPLIANT reply — measured: two searches,
          // eighteen results in hand, and it answered with the one-liner. The
          // July note on the same contact instead named the prominent match and
          // said so. Closing the hatch and demanding attribution restored it:
          // six searches, and the full Hungry Lion / Digicloud briefing.
          "WHEN SEVERAL PEOPLE SHARE THE NAME, REPORT THE BEST-EVIDENCED ONE — do not discard the research. Name the most prominent public match, say plainly that it is a name match rather than a confirmed identity, and give the evidence so the salesperson can judge for themselves. Throwing away a strong public match because you cannot prove it is the same person is the failure to avoid here; inventing detail is the other. You avoid both the same way: attribute. Say what the source is and what it actually supports.\n\n" +
          "Then respond with up to three lines, EXACTLY in this order, each on its own line, each starting with its label and a colon:\n" +
          "Company: what it does, how big it is, where it operates, and anything else that helps someone walk into the conversation informed\n" +
          "Role: the person's role and employer, stated plainly if confirmed, plus prior roles or other ventures if you found them\n" +
          "Fit: why they might want an electric cart (estate, lodge, farm, resort...), and how to approach them\n" +
          "BE THOROUGH. Each label takes as much detail as you actually found — several sentences is right when the sources support it, and a research note that reads as thin or obvious is a failed one. What you must NOT do is put a line break inside a label's text: each label is one line, however long, because a stray newline breaks the card this renders into. Never pad with filler to reach a length — depth comes from what you found, not from wordcount.\n" +
          "Omit a label entirely if you genuinely found nothing for it — do not write \"Company: not found\". Use \"No reliable information found.\" ONLY if the searches genuinely returned nothing usable about anyone of this name: it is the last resort, not the safe default.\n\n" +
          "STATE WHAT YOU FOUND PLAINLY. When a LinkedIn profile or the company's own page directly confirms a role or fact, say it as fact — \"is the CEO of X\", never \"might be tied to X\" or \"possibly works at X\" — because the source said so directly, not because you're certain in the abstract. Reserve hedging (\"appears to be\", \"likely\") for evidence that is genuinely indirect, stale, or where more than one person shares this name and you can't tell which one is the lead. Never fabricate. No preamble, no other text outside the labeled lines.",
    };

    // The opening turn. It lives in `messages` — NOT in `requestBody` — because
    // every call spreads `{ ...requestBody, messages }`, so a copy left behind in
    // the body would be silently replaced by this array and the continuation
    // would resend a conversation the prompt had fallen out of.
    messages.push({
      role: "user",
      content: `Lead: ${input.name}${input.email ? ` <${input.email}>` : ""}\n${
        corporate
          ? `Company domain to research: ${corporate}`
          : "Personal email — research the person (South Africa) only if confidently identifiable."
      }\nCheck LinkedIn for "${input.name}"${corporate ? ` at the company on ${corporate}` : " (South Africa)"} to confirm their role.`,
    });
    // Bounded: a paused turn is resumed at most this many times. The cap exists
    // so a model that keeps pausing cannot spin — and each pass carries the same
    // 90s timeout, so the ceiling is wall-clock as well as count.
    const MAX_CONTINUATIONS = 4;
    let summary = "";

    for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
      const res = await callApi({ ...requestBody, messages });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        await logError("ai-research", `Anthropic API ${res.status}`, text.slice(0, 300));
        return { error: `Research failed (${res.status}).` };
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
    return { summary: summary.slice(0, 2000) };
  } catch (err) {
    await logError("ai-research", err);
    return { error: "Research failed — logged in the System Log." };
  }
}

/**
 * Auto-research: new leads (last 48h) that have an email and no research
 * note yet get a briefing filed automatically. Max 5 per cron run.
 */
export async function runAutoResearch(): Promise<number> {
  if ((await getSetting("AI_AUTO_RESEARCH")) !== "true") return 0;
  if (!(await isAiConfigured())) return 0;
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const leads = await prisma.lead.findMany({
    where: { createdAt: { gte: since }, email: { not: null }, research: null },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  let done = 0;
  for (const lead of leads) {
    if (done >= 5) break;
    const result = await aiResearch({ name: lead.name, email: lead.email });
    if ("error" in result) continue;
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

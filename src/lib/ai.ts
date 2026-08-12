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

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(90000),
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 700,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
        system:
          "You research sales leads for Denago Cape Town, a South African electric golf-cart dealership. Search the web before writing anything — specifically check the person's LinkedIn profile (search their name plus the company, or plus \"South Africa\" if no company is known) for their current role and employer, and check the company's own website and public social profiles (Facebook, Instagram, X/Twitter) for what it does and its size/locale. LinkedIn is usually the most reliable source for a person's current role — search for it directly rather than relying on whatever a generic web search happens to surface.\n\n" +
          "Then respond with up to three lines, EXACTLY in this order, each on its own line, each starting with its label and a colon:\n" +
          "Company: what it does, and size/locale if findable — one line\n" +
          "Role: the person's role and employer, stated plainly if confirmed — one line\n" +
          "Fit: why they might want an electric cart (estate, lodge, farm, resort...) — one line\n" +
          "Omit a label entirely if you genuinely found nothing for it — do not write \"Company: not found\". If you found nothing at all for any of the three, respond with exactly one line: No reliable information found.\n\n" +
          "STATE WHAT YOU FOUND PLAINLY. When a LinkedIn profile or the company's own page directly confirms a role or fact, say it as fact — \"is the CEO of X\", never \"might be tied to X\" or \"possibly works at X\" — because the source said so directly, not because you're certain in the abstract. Reserve hedging (\"appears to be\", \"likely\") for evidence that is genuinely indirect, stale, or where more than one person shares this name and you can't tell which one is the lead. Never fabricate. No preamble, no other text outside the labeled lines.",
        messages: [
          {
            role: "user",
            content: `Lead: ${input.name}${input.email ? ` <${input.email}>` : ""}\n${
              corporate
                ? `Company domain to research: ${corporate}`
                : "Personal email — research the person (South Africa) only if confidently identifiable."
            }\nCheck LinkedIn for "${input.name}"${corporate ? ` at the company on ${corporate}` : " (South Africa)"} to confirm their role.`,
          },
        ],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      await logError("ai-research", `Anthropic API ${res.status}`, text.slice(0, 300));
      return { error: `Research failed (${res.status}).` };
    }
    const json = await res.json();
    void recordAiUsage(json.usage);
    const summary = (json.content ?? [])
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("\n")
      .trim();
    if (!summary) return { error: "No usable research came back." };
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

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
      signal: AbortSignal.timeout(45000),
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 700,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }],
        system:
          "You research sales leads for Denago Cape Town, a South African electric golf-cart dealership. Search the web, then write a tight briefing (max ~120 words, plain text, short lines): what the company does, size/locale if findable, the person's role if findable, and one line on why they might want an electric cart (estate, lodge, farm, resort...). If you find nothing reliable, say exactly that in one line. Never fabricate. No preamble.",
        messages: [
          {
            role: "user",
            content: `Lead: ${input.name}${input.email ? ` <${input.email}>` : ""}\n${
              corporate
                ? `Company domain to research: ${corporate}`
                : "Personal email — research the person (South Africa) only if confidently identifiable."
            }`,
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

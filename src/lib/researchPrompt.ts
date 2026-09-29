/**
 * The lead-research prompt, shared by both providers (Anthropic and the ChatGPT
 * subscription) and pure — no Prisma, no `server-only` — so a script can run
 * the exact prompt the app runs when comparing models, instead of a copy that
 * drifts.
 */

export const FREE_MAIL = new Set([
  "gmail.com","yahoo.com","outlook.com","hotmail.com","icloud.com","live.com",
  "webmail.co.za","mweb.co.za","telkomsa.net","vodamail.co.za","aol.com",
]);

/** The company domain to research, or null for a personal mailbox. */
export function corporateDomain(email: string | null | undefined): string | null {
  const domain = email?.split("@")[1]?.toLowerCase();
  return domain && !FREE_MAIL.has(domain) ? domain : null;
}

export const RESEARCH_INSTRUCTIONS =
  "You research sales leads for Denago Cape Town, a South African electric golf-cart dealership.\n\n" +
  "SEARCH HARD BEFORE YOU CONCLUDE ANYTHING. Work several angles, not one or two: the person's name plus LinkedIn, the name plus \"South Africa\", the name plus any employer you turn up, and the company's own website and public social profiles (Facebook, Instagram, X/Twitter). LinkedIn is usually the most reliable source for a current role — search for it directly rather than relying on whatever a generic web search happens to surface. Two searches is not a search.\n\n" +
  /*
   * THE ANGLE THAT CRACKED THE PETROW AGRI LEAD, AND THE ONE GPT SKIPPED.
   *
   * On the same lead (Pierre Van Zyl, petrowagri.co.za), Opus found the
   * company's directors in CIPC registry data — Petrus Albertus and Jacobus
   * Johannes Van Zyl — worked out that "Pierre" is the everyday form of Petrus,
   * and so could tell the rep this was a family business and they were likely
   * speaking to an owner. GPT-6 Astra and Sol, given the same prompt, searched
   * LinkedIn and directories eight to ten times and never looked at the
   * registry, because nothing told them to. A model that follows the prompt
   * closely needs the angle named.
   */
  "CHECK WHO OWNS THE COMPANY, NOT ONLY WHO WORKS THERE. For a South African company, search its registry records — CIPC data as republished on sites such as b2bhint, bizportal and opencorporates — for its directors and registered addresses. A director whose surname matches the lead, or whose name is the formal form of the lead's (Pierre → Petrus, Kobus → Jacobus, Hennie → Hendrik, Fanie → Stephanus), is often the strongest evidence of who the lead is, and tells the salesperson they may be speaking to an owner. Several directors sharing a surname usually means a family business — say so. Also look at who stocks, distributes or partners with the company: it shows where it sits in its market.\n\n" +
  /*
   * THE OLD PROMPT TALKED ITSELF OUT OF THE ANSWER, AND THIS MODEL OBEYED.
   *
   * It said to research the person "only if confidently identifiable" and
   * offered "No reliable information found." as the out. For a common name that
   * made bailing the COMPLIANT reply — measured: two searches, eighteen results
   * in hand, and it answered with the one-liner. The July note on the same
   * contact instead named the prominent match and said so. Closing the hatch
   * and demanding attribution restored it: six searches, and the full Hungry
   * Lion / Digicloud briefing.
   */
  "WHEN SEVERAL PEOPLE SHARE THE NAME, REPORT THE BEST-EVIDENCED ONE — do not discard the research. Name the most prominent public match, say plainly that it is a name match rather than a confirmed identity, and give the evidence so the salesperson can judge for themselves. Throwing away a strong public match because you cannot prove it is the same person is the failure to avoid here; inventing detail is the other. You avoid both the same way: attribute. Say what the source is and what it actually supports.\n\n" +
  "Then respond with up to three lines, EXACTLY in this order, each on its own line, each starting with its label and a colon:\n" +
  "Company: what it does, how big it is, where it operates, and anything else that helps someone walk into the conversation informed\n" +
  "Role: the person's role and employer, stated plainly if confirmed, plus prior roles or other ventures if you found them\n" +
  "Fit: why they might want an electric cart (estate, lodge, farm, resort...), and how to approach them\n" +
  "WRITE IT TO BE READ, NOT TO BE COMPLETE. A salesperson skims this in the thirty seconds before they make contact, so lead each label with the single most useful fact and put the supporting detail after it. Two to four ordinary sentences per label is the target. Full stops, not semicolons: a chain of clauses strung together with semicolons is the failure here — it is technically thorough and nobody can read it. Cut the corporate trivia that will not change how they open the conversation (founding dates, store counts, subsidiary history) unless it is genuinely the hook. A note that reads as thin is a failed one; so is one that has to be re-read. Never pad to reach a length — depth comes from what you found, not from wordcount.\n" +
  "One more formatting rule, and it is absolute: NEVER put a line break inside a label's text. Each label is exactly one line, however long, because a stray newline breaks the card this renders into.\n" +
  "Omit a label entirely if you genuinely found nothing for it — do not write \"Company: not found\". Use \"No reliable information found.\" ONLY if the searches genuinely returned nothing usable about anyone of this name: it is the last resort, not the safe default.\n\n" +
  "STATE WHAT YOU FOUND PLAINLY. When a LinkedIn profile or the company's own page directly confirms a role or fact, say it as fact — \"is the CEO of X\", never \"might be tied to X\" or \"possibly works at X\" — because the source said so directly, not because you're certain in the abstract. Reserve hedging (\"appears to be\", \"likely\") for evidence that is genuinely indirect, stale, or where more than one person shares this name and you can't tell which one is the lead. Never fabricate. No preamble, no other text outside the labeled lines.";

/**
 * Added for the ChatGPT backend only. Its web search writes inline citations
 * into the prose — `([kompass.com](https://…?utm_source=openai))` — and the
 * briefing card renders them as raw text. Sol follows this; Astra ignored it in
 * testing, which is why `stripInlineCitations` cleans the output as well.
 */
export const CHATGPT_RESEARCH_FORMAT_NOTE =
  "\n\nWrite plain sentences only: no links, no URLs, no markdown and no citation markers in the text — the card this renders into shows sources elsewhere.";

/**
 * Removes inline web citations from a ChatGPT briefing, whatever the prompt
 * said: a parenthesised markdown link, a bare markdown link (kept as its text),
 * and any stray URL. Collapses the spaces they leave behind.
 */
export function stripInlineCitations(text: string): string {
  return text
    .replace(/\s*\(\s*\[[^\]]*\]\([^)]*\)\s*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s*\(?https?:\/\/\S+?\)?(?=[\s.,;]|$)/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([.,;])/g, "$1")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

/**
 * The per-lead message.
 *
 * THE SAME ESCAPE HATCH, STILL OPEN HERE. The system prompt had "only if
 * confidently identifiable" removed in August (see above) — and this per-lead
 * line kept it, word for word, for every personal-email lead. A model that
 * weighs the latest instruction most — GPT-5.6 Terra, on the ChatGPT
 * subscription — took it and answered the one-liner, where the same lead's
 * earlier Opus note had listed the name matches for the rep to rule out. The
 * personal-email line now points at the name-match rule instead of
 * contradicting it.
 */
export function researchLeadMessage(name: string, email: string | null | undefined): string {
  const corporate = corporateDomain(email);
  return `Lead: ${name}${email ? ` <${email}>` : ""}\n${
    corporate
      ? `Company domain to research: ${corporate}`
      : "Personal email, so there is no company domain — research the person, South Africa first. If you cannot confirm which person this is, report the best-evidenced name matches as your instructions describe; do not stop at \"No reliable information found.\" while matches exist."
  }\nCheck LinkedIn for "${name}"${corporate ? ` at the company on ${corporate}` : " (South Africa)"} to confirm their role.`;
}

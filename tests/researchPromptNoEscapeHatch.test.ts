import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  RESEARCH_INSTRUCTIONS,
  corporateDomain,
  researchLeadMessage,
  stripInlineCitations,
} from "../src/lib/researchPrompt";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * The research prompt, executed rather than grepped: it is a pure module now,
 * shared by both providers, so these tests read the exact strings a model gets.
 */

const personal = researchLeadMessage("Arshaad Mohammed", "arshaad@gmail.com");
const corporate = researchLeadMessage("Pierre Van Zyl", "pierre@petrowagri.co.za");

test("NO PART OF THE RESEARCH PROMPT OFFERS GIVING UP AS THE SAFE ANSWER", () => {
  /*
   * "Only if confidently identifiable" was taken out of the system prompt in
   * August because it made giving up the compliant answer, but stayed in the
   * per-lead message for every personal-email lead — and GPT-5.6 Terra took it.
   */
  for (const text of [RESEARCH_INSTRUCTIONS, personal, corporate]) {
    assert.ok(!/only if confidently identifiable/i.test(text), "nothing makes bailing the compliant reply");
  }
});

test("THE PERSONAL-EMAIL LINE POINTS AT THE NAME-MATCH RULE INSTEAD", () => {
  assert.match(personal, /Personal email, so there is no company domain/);
  assert.match(personal, /report the best-evidenced name matches as your instructions describe/);
  assert.match(RESEARCH_INSTRUCTIONS, /WHEN SEVERAL PEOPLE SHARE THE NAME, REPORT THE BEST-EVIDENCED ONE/);

  assert.match(corporate, /Company domain to research: petrowagri\.co\.za/);
  assert.equal(corporateDomain("x@gmail.com"), null);
  assert.equal(corporateDomain("x@PetrowAgri.co.za"), "petrowagri.co.za");
});

test("THE PROMPT NAMES THE REGISTRY ANGLE THAT CRACKED THE PETROW LEAD", () => {
  /*
   * Opus found the company's directors in CIPC registry data and worked out
   * "Pierre" was Petrus; GPT searched LinkedIn and directories ten times and
   * never looked, because nothing told it to. With this paragraph, Sol found
   * them.
   */
  assert.match(RESEARCH_INSTRUCTIONS, /CHECK WHO OWNS THE COMPANY, NOT ONLY WHO WORKS THERE/);
  assert.match(RESEARCH_INSTRUCTIONS, /CIPC/);
  assert.match(RESEARCH_INSTRUCTIONS, /Pierre → Petrus/, "the formal-name link is spelled out");
  assert.match(RESEARCH_INSTRUCTIONS, /family business/);
});

test("INLINE CITATIONS ARE STRIPPED FROM A CHATGPT BRIEFING", () => {
  // Verbatim shape from GPT-6 Astra on the Petrow lead, which ignored the
  // prompt's no-links instruction.
  const astra =
    "Company: Petrow Agri is a fertiliser distributor in Brackenfell, Cape Town. Kompass lists 20–49 employees. " +
    "([bg.kompass.com](https://bg.kompass.com/c/petrow-agri-pty-ltd/zan763193/?utm_source=openai)) " +
    "InteliGro lists PetrowAgri as a partner. ([inteligro.co.za](https://www.inteligro.co.za/partners/petrowagri/?utm_source=openai))\n" +
    "Role: See [LinkedIn](https://za.linkedin.com/in/x?utm_source=openai) for more, or https://example.com/page.";

  const clean = stripInlineCitations(astra);
  assert.ok(!/https?:\/\//.test(clean), "no URL survives");
  assert.ok(!/\]\(|\(\[/.test(clean), "no markdown link syntax survives");
  assert.ok(!/utm_source/.test(clean));
  assert.match(clean, /Kompass lists 20–49 employees\. InteliGro lists PetrowAgri as a partner\./, "the prose around them is intact");
  assert.match(clean, /Role: See LinkedIn for more, or\./, "a bare markdown link keeps its text");
  assert.equal(clean.split("\n").length, 2, "each label is still one line — a stray break would shred the card");

  const plain = "Company: Acme builds estates.\nRole: Director.";
  assert.equal(stripInlineCitations(plain), plain, "clean text is left alone");
});

test("THE CHATGPT PATH ASKS FOR ITS BEST WORK AND CLEANS WHAT COMES BACK", () => {
  const ai = src("src/lib/ai.ts");
  const research = ai.slice(ai.indexOf("export async function aiResearch"), ai.indexOf("export async function runAutoResearch"));
  assert.match(research, /instructions: RESEARCH_INSTRUCTIONS \+ CHATGPT_RESEARCH_FORMAT_NOTE/);
  assert.match(research, /reasoningEffort: "high",/);
  assert.match(research, /verbosity: "high",/);
  assert.match(research, /timeoutMs: 150_000,/, "a 50–80 second call is not cut off at 90");
  assert.match(research, /summary = await stripResearchPreamble\(stripInlineCitations\(reply\.text\)\);/);

  // And both providers read the one prompt.
  assert.match(research, /system: RESEARCH_INSTRUCTIONS,/);
  assert.match(research, /content: researchLeadMessage\(input\.name, input\.email\)/);

  const codex = src("src/lib/codex.ts");
  assert.match(codex, /\.\.\.\(input\.reasoningEffort \? \{ reasoning: \{ effort: input\.reasoningEffort \} \} : \{\}\)/);
  assert.match(codex, /\.\.\.\(input\.verbosity \? \{ text: \{ verbosity: input\.verbosity \} \} : \{\}\)/);
});

import { z } from "zod";

/**
 * The assistant's personality — one short "soul" put in front of every answer.
 *
 * The idea, and the default's rules, come from Hermes Agent's SOUL.md (Nous
 * Research, MIT): be direct, match the length of the reply to the weight of the
 * question, no filler, agree because it's right rather than because the user
 * said it, and say plainly when unsure. Each workspace names it and sets its
 * tone and house rules in Settings → Assistant (stored as ASSISTANT_PROFILE).
 */

export const ASSISTANT_PROFILE_KEY = "ASSISTANT_PROFILE";

export const TONES = {
  warm: "Warm and encouraging, like a good sales manager who has your back.",
  direct: "Direct and businesslike — straight to the point, no small talk.",
  formal: "Polite and formal, as you would write to a senior colleague.",
  playful: "Light and upbeat, with the odd bit of humour — never at the customer's expense.",
} as const;
export type Tone = keyof typeof TONES;

export const assistantProfile = z.object({
  name: z.string().trim().min(1).max(40).default("Assistant"),
  tone: z.enum(Object.keys(TONES) as [Tone, ...Tone[]]).default("warm"),
  /** House rules in the owner's words ("always mention the 5-year warranty"). */
  rules: z.string().trim().max(1500).default(""),
});
export type AssistantProfile = z.infer<typeof assistantProfile>;

export const DEFAULT_PROFILE: AssistantProfile = { name: "Assistant", tone: "warm", rules: "" };

/** Stored JSON → profile; anything unreadable falls back to the default. */
export function parseProfile(raw: string | null | undefined): AssistantProfile {
  if (!raw) return DEFAULT_PROFILE;
  try {
    const parsed = assistantProfile.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : DEFAULT_PROFILE;
  } catch {
    return DEFAULT_PROFILE;
  }
}

/** The soul text for the answer step. */
export function soulText(profile: AssistantProfile, company: string, userName: string): string {
  return [
    `You are ${profile.name}, the sales assistant inside ${company || "this business"}'s CRM, talking with ${userName}.`,
    `Tone: ${TONES[profile.tone]}`,
    "How you work:",
    "- You are a knowledgeable colleague, not a search box: read what the CRM returned, connect the dots, and say what it means and what to do about it.",
    "- Match the length of your reply to the weight of the question: a quick question gets a line or two; a 'what should I do' gets a short plan.",
    "- No filler (\"Great question\", \"I'd be happy to\"), no restating the question, no narrating what you looked up.",
    "- Keep FACTS (what the records say) apart from ADVICE (what you'd do). Never present a guess as a fact; if the records don't say, say so plainly.",
    "- Agree because it's right, not because you were told to. If the data points another way, say so kindly.",
    "- Money is South African rand; dates are South African time.",
    profile.rules ? `House rules from the business (follow these):\n${profile.rules}` : "",
  ].filter(Boolean).join("\n");
}

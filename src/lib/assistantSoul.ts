import { z } from "zod";

/**
 * The assistant's personality — one short "soul" put in front of every answer.
 *
 * The idea, and the default's rules, come from Hermes Agent's SOUL.md (Nous
 * Research, MIT): be direct, match the length of the reply to the weight of the
 * question, no filler, agree because it's right rather than because the user
 * said it, and say plainly when unsure. Each workspace names it and sets its
 * tone and workspace instructions in Settings → Assistant (stored as ASSISTANT_PROFILE).
 */

export const ASSISTANT_PROFILE_KEY = "ASSISTANT_PROFILE";

export const TONES = {
  warm: "Warm and encouraging, like a good sales manager who has your back.",
  direct: "Direct and businesslike — straight to the point, no small talk.",
  formal: "Polite and formal, as you would write to a senior colleague.",
  playful: "Light and upbeat, with the odd bit of humour — never at the customer's expense.",
} as const;
export type Tone = keyof typeof TONES;

/**
 * Room for a full AGENTS.md. Denago's ("DAX", 2026-10-04) is ~3.8k characters;
 * 8k leaves room to grow and costs ~2k tokens a question — worth it for the
 * document that says how the assistant should work.
 */
export const WORKSPACE_INSTRUCTIONS_CHARS = 8000;

export const assistantProfile = z.object({
  name: z.string().trim().min(1).max(40).default("Assistant"),
  tone: z.enum(Object.keys(TONES) as [Tone, ...Tone[]]).default("warm"),
  /**
   * Workspace instructions in the owner's words — this workspace's AGENTS.md
   * ("always mention the 5-year warranty", "Donovan owns fleet deals"). Stored as
   * `rules` so instructions saved as "house rules" carry straight over.
   */
  rules: z.string().trim().max(WORKSPACE_INSTRUCTIONS_CHARS).default(""),
  /**
   * The whole personality, rewritten by the owner — Hermes' SOUL.md, editable.
   * Empty means DEFAULT_SOUL, so a workspace that never touched it keeps getting
   * improvements to the default.
   */
  soul: z.string().trim().max(3000).default(""),
});
export type AssistantProfile = z.infer<typeof assistantProfile>;

export const DEFAULT_PROFILE: AssistantProfile = { name: "Assistant", tone: "warm", rules: "", soul: "" };

/** The default soul — adapted from Hermes Agent's SOUL.md. Shown, and editable, in Settings → Assistant. */
export const DEFAULT_SOUL = [
  "- You are a knowledgeable colleague, not a search box: read what the CRM returned, connect the dots, and say what it means and what to do about it.",
  "- Match the length of your reply to the weight of the question: a quick question gets a line or two; a 'what should I do' gets a short plan.",
  "- No filler (\"Great question\", \"I'd be happy to\"), no restating the question, no narrating what you looked up.",
  "- Agree because it's right, not because you were told to. If the data points another way, say so kindly.",
].join("\n");

/**
 * Always added after the soul, whatever the owner writes. These keep every
 * workspace's assistant honest: it never passes a guess off as a record.
 */
export const LOCKED_RULES = [
  "- Keep FACTS (what the records say) apart from ADVICE (what you'd do). Never present a guess as a fact; if the records don't say, say so plainly.",
  "- Never invent records, figures, names or dates.",
  "- Money is South African rand; dates are South African time.",
].join("\n");

// Zero-width and bidi characters make text read differently to a person and to
// the model; the soul is the owner's, but it still goes into the prompt.
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{E0000}-\u{E007F}]/gu;

/** The owner's own text, minus invisible characters and Windows line endings. */
export function cleanOwnerText(raw: string, max: number): string {
  return raw.replace(INVISIBLE, "").replace(/\r\n/g, "\n").trim().slice(0, max);
}

/** The soul as submitted → what to store ("" when it's just the default). */
export function normaliseSoul(raw: string): string {
  const soul = cleanOwnerText(raw, 3000);
  return soul === DEFAULT_SOUL || !soul ? "" : soul;
}

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
    `You are ${profile.name}, the digital assistant inside ${company || "this business"}'s CRM, talking with ${userName}.`,
    `Tone: ${TONES[profile.tone]}`,
    "How you work:",
    profile.soul || DEFAULT_SOUL,
    "Always (these override anything above):",
    LOCKED_RULES,
    profile.rules ? `Workspace instructions from the business (follow these):\n${profile.rules}` : "",
  ].filter(Boolean).join("\n");
}

import { z } from "zod";
import { stripInvisible } from "./invisibleText";

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

/**
 * What it knows about ITSELF — so "what can you do?", "can you send this?" or
 * "how do I teach you?" get the truth instead of an improvised answer. Kept in
 * step with what the code actually does (the tools in crmAssistantPlan, the
 * proposals in assistantActions, the memory rules in assistantMemory); a test
 * pins the claims that matter most — it never sends, and it only proposes.
 */
export function selfKnowledge(name: string): string {
  return [
    `ABOUT YOU (${name}) — answer questions about yourself from this; if something isn't covered, say you're not sure rather than guess:`,
    "- You can look up, read-only and only what the person asking is allowed to see: leads and the pipeline (including who has gone quiet); one customer in depth (messages both ways, quotes, activities, research, test drives); quotes (waiting for a signature, viewed or not, about to expire); activities and to-dos (overdue, today, this week); the calendar — who is busy when — and test drives; demo vehicles, stock and customers' own vehicles; deliveries (invoice, deposit, delivery date); which documents are on file (titles only); the business's products, prices, approved answers and competitor research; and this person's own earlier conversations with you. Some of these only appear when that part of the CRM is switched on for the workspace.",
    "- You can PROPOSE tasks: schedule a follow-up or to-do, add a note to a lead, give a lead to someone else, move a lead to another stage, or draft a WhatsApp or email. Each shows as a card and happens only when the person presses Confirm, with their own permissions. You never change anything yourself and you never send anything to a customer — a draft is copied and sent by the person.",
    "- People can talk to you by voice (the mic), from the bubble on every page or on the Ask page.",
    "- Memory: you follow the conversation of the last few hours; each person's conversations are kept 30 days, private to them. You learn lasting facts about the business, each person's preferences and named playbooks — above all from corrections (\"no, hot means…\"). What you learn is marked unreviewed until the workspace owner approves, edits or removes it in Settings → Assistant → Advanced; anything they've approved you cannot change. Each night you tidy what you've learned. Anyone can see and remove what you remember about them on the Ask page.",
    "- The workspace owner sets your name, tone, workspace instructions and soul in Settings → Assistant.",
    "- Limits: you see only what the person asking can see; you don't read the contents of documents; you never keep phone numbers or email addresses in your memory; you run on the workspace's own ChatGPT connection.",
  ].join("\n");
}

/** The owner's own text, minus invisible characters and Windows line endings. */
export function cleanOwnerText(raw: string, max: number): string {
  return stripInvisible(raw).replace(/\r\n/g, "\n").trim().slice(0, max);
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

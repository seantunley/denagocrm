import { z } from "zod";

/**
 * Turning a spoken call/visit debrief into an activity — the pure half, so the
 * parsing is testable without ChatGPT.
 *
 * The model only DRAFTS: the person sees summary, notes and the suggested
 * follow-up, edits them, and nothing is saved until they press Save.
 */

export const DEBRIEF_INSTRUCTIONS = [
  "You turn a salesperson's spoken debrief of a customer call or visit into CRM notes.",
  'Output JSON only: {"summary":"<what happened, max 80 chars>","notes":["<fact>", ...],"nextStep":"<the agreed next action, or empty>","followUpDays":<whole days from today until that next action, or null>}',
  "Notes: 2–6 short factual points — what the customer wants, objections, prices or dates mentioned, what was promised.",
  "Use only what was said. Never invent names, prices or dates. Keep the language the salesperson used.",
].join("\n");

const debrief = z.object({
  summary: z.string().trim().min(1).max(120),
  notes: z.array(z.string().trim().min(1).max(300)).max(8).default([]),
  nextStep: z.string().trim().max(200).optional().default(""),
  followUpDays: z.number().int().min(0).max(365).nullable().optional().default(null),
});

export type DebriefDraft = {
  summary: string;
  notes: string;
  nextStep: string;
  /** YYYY-MM-DD in Johannesburg, or "" when no follow-up was agreed. */
  followUpDate: string;
  transcript: string;
};

/** Model reply → draft; null if it isn't the shape asked for. */
export function parseDebrief(reply: string, transcript: string, today: string): DebriefDraft | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = debrief.safeParse(raw);
  if (!parsed.success) return null;
  const { summary, notes, nextStep, followUpDays } = parsed.data;
  return {
    summary: summary.slice(0, 80),
    notes: notes.map((n) => `• ${n}`).join("\n"),
    nextStep,
    followUpDate: followUpDays == null ? "" : addDays(today, followUpDays),
    transcript,
  };
}

/** Without ChatGPT the transcript is still the record — just not summarised. */
export function plainDebrief(transcript: string): DebriefDraft {
  const firstSentence = transcript.split(/(?<=[.!?])\s/)[0] ?? transcript;
  return {
    summary: firstSentence.slice(0, 80),
    notes: "",
    nextStep: "",
    followUpDate: "",
    transcript,
  };
}

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00+02:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

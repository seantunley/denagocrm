import { z } from "zod";

/**
 * How the assistant learns — the pure half (parsing, limits, safety scan).
 *
 * Ported from Hermes Agent's memory tool and skills (Nous Research, MIT):
 *  - MEMORY.md → workspace MEMORY: facts about this business that matter in every
 *    conversation (who handles what, conventions, policies someone stated).
 *  - USER.md → a personal PROFILE per user: how they like answers, their role/area.
 *  - skills → PLAYBOOKS: a named definition or procedure ("hot lead" = …), with a
 *    ≤60-character description that sits in every prompt and a body that loads
 *    only when needed.
 * Same discipline as Hermes: small hard caps (memory is in every prompt), only
 * durable facts, and every entry scanned for injected instructions because it
 * becomes part of the system prompt. Sean chose "learns on its own, the owner
 * reviews": entries apply straight away, marked unreviewed until approved.
 */

export const MEMORY_CHAR_LIMIT = 2200; // Hermes' MEMORY.md default
export const PROFILE_CHAR_LIMIT = 1400; // Hermes' USER.md default
export const PLAYBOOK_LIMIT = 30;
export const PLAYBOOK_CHARS = 1500;
export const ENTRY_CHARS = 400;

const entryText = z.string().trim().min(3).max(ENTRY_CHARS);
const noteOp = z.union([
  z.object({ add: entryText }).strict(),
  z.object({ replace: z.object({ old: z.string().trim().min(3).max(ENTRY_CHARS), new: entryText }).strict() }).strict(),
  z.object({ remove: z.string().trim().min(3).max(ENTRY_CHARS) }).strict(),
]);
export const playbookOp = z
  .object({
    name: z.string().trim().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(48),
    description: z.string().trim().min(3).max(60),
    content: z.string().trim().min(10).max(PLAYBOOK_CHARS),
  })
  .strict();

export const learnBlock = z
  .object({
    memory: z.array(noteOp).max(5).optional(),
    profile: z.array(noteOp).max(5).optional(),
    playbook: z.array(playbookOp).max(3).optional(),
  })
  .strict();
export type LearnBlock = z.infer<typeof learnBlock>;
export type NoteOp = z.infer<typeof noteOp>;

export const LEARN_INSTRUCTIONS = [
  "LEARNING. You remember across conversations. After your answer, ONLY if this exchange taught you something durable, add one final line:",
  'LEARN: {"memory":[{"add":"..."}],"profile":[{"add":"..."}],"playbook":[{"name":"hot-lead","description":"<=60 chars","content":"..."}]}',
  'Each list is optional. Ops: {"add":"text"}, {"replace":{"old":"words in the existing entry","new":"whole new entry"}}, {"remove":"words in the entry"}.',
  "- memory: facts about THIS BUSINESS that matter in every future conversation — who handles what, how things are done here, policies someone told you.",
  "- profile: this person's own lasting preferences — how they like answers, their role, their area.",
  "- playbook: a named definition or procedure the person taught or corrected (\"hot lead means…\", \"our weekly review is…\"). name is lowercase-hyphenated.",
  "A correction from the person is the most important thing to learn. If an entry you were given is wrong or out of date, replace or remove it.",
  "SKIP: anything about one particular customer or deal, data that lives in the CRM records, one-off tasks, guesses. Never store a phone number, email address or a customer's name.",
  "Most answers learn nothing — then add no LEARN line at all.",
].join("\n");

/** Split the model's reply into the answer the person sees and what it wants to learn. */
export function splitLearn(reply: string): { answer: string; learn: LearnBlock | null } {
  const lines = reply.trimEnd().split("\n");
  const at = lines.findLastIndex((line) => line.trim().startsWith("LEARN:"));
  if (at === -1) return { answer: reply.trim(), learn: null };
  const answer = lines.filter((_, i) => i !== at).join("\n").trim();
  const json = lines[at].trim().slice("LEARN:".length).trim();
  try {
    const parsed = learnBlock.safeParse(JSON.parse(json));
    return { answer, learn: parsed.success ? parsed.data : null };
  } catch {
    return { answer, learn: null };
  }
}

/* ── Safety scan ─────────────────────────────────────────────────────────── */

// Zero-width, bidi embeddings/overrides/isolates and tag characters — they make
// text read one way to a person and another to the model (Hermes' source hygiene).
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{E0000}-\u{E007F}]/gu;

const INJECTION = [
  /ignore (all |any |the )?(previous|prior|above|earlier) (instructions|rules|messages)/i,
  /disregard (all |any |the )?(previous|prior|above|your) /i,
  /\b(system|developer) prompt\b/i,
  /\byou are now\b/i,
  /\bnew instructions?\b/i,
  /\b(reveal|print|show|send|leak)\b.{0,40}\b(prompt|instructions|api ?key|token|password|secret)/i,
  /\b(api ?key|password|secret|token)\s*[:=]/i,
  /<\s*\/?\s*(script|system|instructions?)\b/i,
  /\bLEARN:/,
];
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE = /(\+?\d[\d\s-]{8,}\d)/;

/** Cleaned text, or a reason it may not be learned. */
export function scanEntry(raw: string): { ok: true; text: string } | { ok: false; reason: string } {
  const text = raw.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  if (text.length < 3) return { ok: false, reason: "empty" };
  if (INJECTION.some((pattern) => pattern.test(text))) return { ok: false, reason: "looks like an instruction to the assistant" };
  if (EMAIL.test(text) || PHONE.test(text)) return { ok: false, reason: "contains contact details" };
  return { ok: true, text };
}

/* ── Applying ops to a list of entries (pure, so limits are testable) ───── */

export type Entry = { id: string; content: string; status: string };
export type Change =
  | { kind: "create"; content: string }
  | { kind: "update"; id: string; content: string }
  | { kind: "delete"; id: string };

/**
 * Ops → changes against the current entries, refusing anything over `limit`
 * total characters. Approved entries are the owner's: the assistant may only
 * replace or remove its own unreviewed ones (it adds a correction instead).
 */
export function planNoteChanges(entries: Entry[], ops: NoteOp[], limit: number): Change[] {
  const working = entries.map((e) => ({ ...e }));
  const changes: Change[] = [];
  const total = () => working.reduce((n, e) => n + e.content.length, 0);
  const find = (words: string) => working.find((e) => e.content.toLowerCase().includes(words.toLowerCase()));

  for (const op of ops) {
    if ("add" in op) {
      const scanned = scanEntry(op.add);
      if (!scanned.ok) continue;
      if (working.some((e) => e.content.toLowerCase() === scanned.text.toLowerCase())) continue;
      if (total() + scanned.text.length > limit) continue;
      working.push({ id: `new-${changes.length}`, content: scanned.text, status: "unreviewed" });
      changes.push({ kind: "create", content: scanned.text });
    } else if ("replace" in op) {
      const target = find(op.replace.old);
      const scanned = scanEntry(op.replace.new);
      if (!target || !scanned.ok || target.status === "approved") continue;
      if (total() - target.content.length + scanned.text.length > limit) continue;
      target.content = scanned.text;
      changes.push(target.id.startsWith("new-") ? { kind: "create", content: scanned.text } : { kind: "update", id: target.id, content: scanned.text });
    } else {
      const target = find(op.remove);
      if (!target || target.status === "approved" || target.id.startsWith("new-")) continue;
      working.splice(working.indexOf(target), 1);
      changes.push({ kind: "delete", id: target.id });
    }
  }
  return changes;
}

/** The learned block for the prompt — unreviewed entries marked so the model weighs them. */
export function memoryPrompt(input: {
  memory: Entry[];
  profile: Entry[];
  playbooks: { name: string; description: string; status: string }[];
}): string {
  const mark = (e: { status: string }) => (e.status === "approved" ? "" : " (unreviewed)");
  const parts: string[] = [];
  if (input.memory.length) parts.push(`What you know about this business:\n${input.memory.map((e) => `- ${e.content}${mark(e)}`).join("\n")}`);
  if (input.profile.length) parts.push(`What you know about this person:\n${input.profile.map((e) => `- ${e.content}${mark(e)}`).join("\n")}`);
  if (input.playbooks.length) {
    parts.push(`Playbooks you've learned (load one with the playbook tool when relevant):\n${input.playbooks.map((p) => `- ${p.name}: ${p.description}${mark(p)}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

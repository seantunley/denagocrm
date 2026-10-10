/**
 * Case memory: decisions about a customer or topic, stored separately from
 * the prompt-sized business memory.
 *
 * Pure half: format, parse, and match. The store writes AssistantNote rows
 * with kind "decision". Subject type is explicit (lead | topic) — never guessed
 * from the string shape.
 */

export type DecisionKind = "lead" | "topic";

export type Decision = {
  kind: DecisionKind;
  /** Lead id when kind is "lead"; a short topic slug otherwise. */
  subject: string;
  text: string;
  at: string; // ISO
};

const MAX_TEXT = 400;

/** "lead:<id> | …" or "topic:<slug> | …". */
export function formatDecision(d: Decision): string {
  return `${d.kind}:${d.subject} | ${d.text.slice(0, MAX_TEXT)}`;
}

export function parseDecision(content: string, at: string): Decision | null {
  // No /s flag — the target does not support it. [\s\S] matches across lines.
  const m = content.match(/^(lead|topic):([^|]+)\|\s*([\s\S]+)$/);
  if (!m) return null;
  const kind = m[1] as DecisionKind;
  return { kind, subject: m[2].trim(), text: m[3].trim(), at };
}

/**
 * Rank decisions for a query. Prefer exact subject match, then text overlap.
 */
export function matchDecisions(decisions: Decision[], query: string, limit = 5): Decision[] {
  const q = query.toLowerCase();
  const words = q.split(/\W+/).filter((w) => w.length > 2);
  const scored = decisions.map((d) => {
    let score = 0;
    if (q.includes(d.subject.toLowerCase()) || d.subject.toLowerCase().includes(q)) score += 5;
    for (const w of words) {
      if (d.text.toLowerCase().includes(w)) score += 1;
    }
    return { d, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.d);
}

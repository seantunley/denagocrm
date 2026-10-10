/**
 * Case memory: decisions about a customer or topic, stored separately from
 * the prompt-sized business memory.
 *
 * Pure half: format, parse, and match. The store writes AssistantNote rows
 * with kind "decision" (name = lead id or topic slug, content = the decision).
 */

export type Decision = {
  /** Lead id, or a short topic slug when it is not about one lead. */
  subject: string;
  text: string;
  at: string; // ISO
};

const MAX_TEXT = 400;

/** "lead:abc | Wait until finance replies" or "topic:pricing | Hold the promo". */
export function formatDecision(d: Decision): string {
  const kind = d.subject.startsWith("c") && d.subject.length > 20 ? "lead" : "topic";
  return `${kind}:${d.subject} | ${d.text.slice(0, MAX_TEXT)}`;
}

export function parseDecision(content: string, at: string): Decision | null {
  const m = content.match(/^(lead|topic):([^|]+)\|\s*(.+)$/s);
  if (!m) return null;
  return { subject: m[2].trim(), text: m[3].trim(), at };
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

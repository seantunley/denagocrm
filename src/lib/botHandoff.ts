export const DEFAULT_HANDOFF_SLA_MINUTES = 15;

export type BotHandoffConfidence = "high" | "medium" | "low";

export type BotHandoffContext = {
  reason: string | null;
  summary: string | null;
  intent: string | null;
  confidence: BotHandoffConfidence | null;
  requestedAt: Date;
  dueAt: Date;
  overdue: boolean;
};

function clean(value: unknown, max = 500): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function confidence(value: unknown): BotHandoffConfidence | null {
  return value === "high" || value === "medium" || value === "low" ? value : null;
}

/** Reads handoff metadata from both WhatsApp's flat state and DM's packed state. */
export function handoffContext(
  rawVars: string | null,
  requestedAt: Date,
  now = new Date(),
  slaMinutes = DEFAULT_HANDOFF_SLA_MINUTES,
): BotHandoffContext {
  let vars: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(rawVars || "{}");
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      vars = record.v && typeof record.v === "object" ? record.v as Record<string, unknown> : record;
    }
  } catch {
    // A corrupt diagnostic payload must not hide the handoff from the queue.
  }
  const minutes = Number.isFinite(slaMinutes) ? Math.min(1440, Math.max(1, slaMinutes)) : DEFAULT_HANDOFF_SLA_MINUTES;
  const dueAt = new Date(requestedAt.getTime() + minutes * 60_000);
  return {
    reason: clean(vars.__handoff_reason),
    summary: clean(vars.__handoff_summary, 1000),
    intent: clean(vars.__handoff_intent, 120),
    // Flow writers persist the confidence enum verbatim. Keep the reader on the
    // same contract instead of coercing those words through Number(), which
    // turned every real production value into NaN/null.
    confidence: confidence(vars.__handoff_confidence),
    requestedAt,
    dueAt,
    overdue: dueAt.getTime() < now.getTime(),
  };
}

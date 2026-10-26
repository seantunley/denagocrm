import { johannesburgDateKey } from "./activityDay";
import { OR_AUTOMATIC, messageAuthor, type Who } from "./assistantWho";
import type { AuditDetail } from "./auditDetail";
import { openedFact } from "./emailOpenTracking";

/**
 * "Why did this happen?" — a record's history as CAUSE AND EFFECT, for DAX.
 *
 * Pure: the lookup (assistantWhyLookup.ts) reads the rows the person may see and
 * hands them here; this turns them into one short, dated list — what happened,
 * and what caused it: a person by name, a journey and its step, the chatbot, the
 * customer — or plainly "not recorded". Nothing is inferred: a cause is given
 * only where a row SAYS it. The answer step separates that from its own guesses.
 */

/** What one answer may carry: the newest this many events. */
export const WHY_MAX_EVENTS = 40;

export type WhyEvent = {
  /** "YYYY-MM-DD HH:mm", South African time. */
  when: string;
  what: string;
  /** Who or what caused it, from the record — or "not recorded". */
  cause: string;
  /** Field changes: "stage: New → Contacted". */
  changed?: string[];
  [fact: string]: unknown;
};

export const NOT_RECORDED = "not recorded";

const SA_TIME = { timeZone: "Africa/Johannesburg", hour: "2-digit", minute: "2-digit", hour12: false } as const;
export const stamp = (d: Date) => `${johannesburgDateKey(d)} ${d.toLocaleTimeString("en-GB", SA_TIME)}`;
const clip = (s: string | null | undefined, n: number) => (s ? (s.length > n ? `${s.slice(0, n)}…` : s) : null);

/**
 * An audit entry's cause. A row with a user id was done by that person (every
 * automatic writer passes only a name — "Journey engine", "Chatbot", "System",
 * "Customer portal", "Website" — and no user).
 */
export function auditCause(row: { userId: string | null; userName: string }): string {
  return row.userId ? `person: ${row.userName}` : `automatic: ${row.userName || "System"}`;
}

/** Contact details never go to the model, even inside a change (crmAssistant leaves them out everywhere). */
const PRIVATE_FIELD = /email|phone|whatsapp|address|idnumber|passport|psid|instagram/i;

/**
 * "field: before → after", with ids (stages, people) put into words through
 * `names`. An id nothing names is left out rather than shown as a code.
 */
export function describeChanges(detail: AuditDetail | undefined, names: ReadonlyMap<string, string>): string[] {
  if (!detail) return [];
  const show = (v: unknown): string => {
    if (v === null || v === undefined || v === "") return "(empty)";
    if (typeof v === "string") return names.get(v) ?? (/^c[a-z0-9]{20,}$/i.test(v) ? "(a record)" : clip(v, 80)!);
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return "(changed)";
  };
  return detail.changed
    .filter((c) => !/^(position|pipelineId|raw|research|notes)$/.test(c.field))
    .slice(0, 6)
    .map((c) => (PRIVATE_FIELD.test(c.field) ? `${c.field}: changed` : `${c.field}: ${show(c.before)} → ${show(c.after)}`));
}

export type AuditRow = { id: string; action: string; summary: string; userId: string | null; userName: string; createdAt: Date };

export function auditEvents(rows: AuditRow[], detail: Record<string, AuditDetail>, names: ReadonlyMap<string, string>): WhyEvent[] {
  return rows.map((r) => {
    const changed = describeChanges(detail[r.id], names);
    return { when: stamp(r.createdAt), at: r.createdAt.getTime(), what: clip(r.summary, 200)!, action: r.action, cause: auditCause(r), ...(changed.length ? { changed } : {}) };
  });
}

/** The marker the journey engine writes at the top of every email/SMS it sends (journeyStepExecutor). */
const JOURNEY_MARK = /^\[Journey: ([^\]\n]{1,120})\]/;

export type SendRow = {
  occurredAt: Date; direction: string | null; type: string; subject: string | null; body: string; user: Who;
  openToken?: string | null; messageId?: string | null; seenAt?: Date | null; openCount?: number; bouncedAt?: Date | null; bounceReason?: string | null;
};

/**
 * Why a message is on the record: the journey that sent it, the chatbot (and
 * whether it handed over), the customer, or the person whose account it is
 * under — with the stand-in doubt assistantWho explains.
 */
export function sendCause(c: SendRow, standInId: string | null): string {
  const journey = JOURNEY_MARK.exec(c.body ?? "");
  if (journey) return `journey "${journey[1]}"`;
  const subject = c.subject ?? "";
  if (subject.startsWith("🤖 Assistant")) return subject.includes("handoff") ? "chatbot (AI) — and it handed the chat over to a person here" : "chatbot (AI reply)";
  const rule = /^🤖 Auto-reply \(([^)]*)\)/.exec(subject);
  if (rule) return `chatbot auto-reply (${rule[1] === "after-hours" ? "after-hours message" : `keyword rule "${rule[1]}"`})`;
  if (subject.startsWith("🤖 Flow")) return "chatbot flow";
  const { from, loggedBy } = messageAuthor(c, standInId);
  if (from === "customer") return loggedBy ? `the customer (logged by ${loggedBy})` : "the customer";
  if (!loggedBy) return NOT_RECORDED;
  return loggedBy.endsWith(OR_AUTOMATIC) ? `filed under ${loggedBy}` : `person: ${loggedBy}`;
}

export function sendEvents(rows: SendRow[], standInId: string | null): WhyEvent[] {
  return rows.map((c) => {
    const body = (c.body ?? "").replace(JOURNEY_MARK, "").trim();
    return {
      when: stamp(c.occurredAt),
      at: c.occurredAt.getTime(),
      what: `${c.direction === "inbound" ? "Received" : c.direction === "outbound" ? "Sent" : "Logged"} ${c.type}${c.subject && !c.subject.startsWith("🤖") ? `: ${clip(c.subject, 80)}` : ""}`,
      cause: sendCause(c, standInId),
      text: clip(body, 140),
      ...openedFact(c),
    };
  });
}

export type JourneyRunRow = {
  journeyName: string; status: string; createdAt: Date; completedAt: Date | null; lastError: string | null;
  steps: { stepType: string; status: string; note: string | null; startedAt: Date }[];
};

/** One event per enrolment: the journey, how far it got, each step's outcome and why it stopped. */
export function journeyEvents(runs: JourneyRunRow[]): WhyEvent[] {
  return runs.map((r) => ({
    when: stamp(r.createdAt),
    at: r.createdAt.getTime(),
    what: `Enrolled in journey "${r.journeyName}" — run ${r.status}${r.completedAt ? ` (${stamp(r.completedAt)})` : ""}`,
    cause: `journey "${r.journeyName}"`,
    steps: [...r.steps]
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
      .slice(-8)
      .map((s) => `${stamp(s.startedAt)} ${s.stepType} ${s.status}${s.note ? ` — ${clip(s.note, 120)}` : ""}`),
    ...(r.lastError && r.status !== "completed" ? { stoppedBecause: clip(r.lastError, 200) } : {}),
  }));
}

export type JourneyDecisionRow = { type: string; createdAt: Date; decisions: unknown };

/** Journeys that looked at a trigger and did NOT enrol — "why didn't she get it?". Enrolments are journeyEvents. */
export function notEnrolledEvents(rows: JourneyDecisionRow[]): WhyEvent[] {
  return rows.flatMap((r) => {
    const list = Array.isArray(r.decisions) ? r.decisions : [];
    return list
      .filter((d): d is { journeyName?: unknown; enrolled?: unknown; reason?: unknown } => !!d && typeof d === "object" && (d as { enrolled?: unknown }).enrolled === false)
      .slice(0, 4)
      .map((d) => ({
        when: stamp(r.createdAt),
        at: r.createdAt.getTime(),
        what: `Trigger "${r.type}" — journey "${String(d.journeyName ?? "?")}" did not enrol`,
        cause: `journey rules: ${clip(String(d.reason ?? NOT_RECORDED), 120)}`,
      }));
  });
}

export type QuoteRow = {
  number: number; createdAt: Date; createdBy: { name: string } | null;
  emailedAt: Date | null; viewedAt: Date | null; signedAt: Date | null; reminderSentAt: Date | null;
  declinedAt: Date | null; declineReason: string | null; changeRequestedAt: Date | null; changeRequestNote: string | null;
};

/** The dates a quote keeps on itself — each one a customer action or an automatic reminder. */
export function quoteEvents(quotes: QuoteRow[]): WhyEvent[] {
  return quotes.flatMap((q) => {
    const n = `Q-${q.number}`;
    const ev = (d: Date | null, what: string, cause: string, extra: Record<string, unknown> = {}): WhyEvent[] =>
      d ? [{ when: stamp(d), at: d.getTime(), what: `${n}: ${what}`, cause, ...extra }] : [];
    return [
      ...ev(q.createdAt, "created", q.createdBy ? `person: ${q.createdBy.name}` : NOT_RECORDED),
      ...ev(q.emailedAt, "emailed to the customer", NOT_RECORDED),
      ...ev(q.viewedAt, "customer first opened the signing link", "the customer"),
      ...ev(q.reminderSentAt, "unsigned-quote reminder sent", "automatic reminder"),
      ...ev(q.changeRequestedAt, "customer asked for changes", "the customer", q.changeRequestNote ? { note: clip(q.changeRequestNote, 160) } : {}),
      ...ev(q.declinedAt, "customer declined", "the customer", q.declineReason ? { reason: clip(q.declineReason, 160) } : {}),
      ...ev(q.signedAt, "signed", "the customer"),
    ];
  });
}

export type BotFlowRow = { eventType: string; occurredAt: Date; flowName: string | null };

export function botFlowEvents(rows: BotFlowRow[]): WhyEvent[] {
  const said: Record<string, string> = { flow_started: "Chatbot flow started", flow_handoff: "Chatbot flow handed the chat to a person", flow_completed: "Chatbot flow finished" };
  return rows.map((r) => ({
    when: stamp(r.occurredAt),
    at: r.occurredAt.getTime(),
    what: said[r.eventType] ?? r.eventType,
    cause: r.flowName ? `chatbot flow "${r.flowName}"` : "chatbot flow",
  }));
}

/**
 * Everything, oldest first, the newest WHY_MAX_EVENTS kept. Same-minute ties
 * keep their source order. `at` is for sorting only and is dropped.
 */
export function whyTimeline(events: WhyEvent[]): { events: WhyEvent[]; truncated: boolean } {
  const sorted = [...events].sort((a, b) => (a.at as number) - (b.at as number));
  const kept = sorted.slice(-WHY_MAX_EVENTS).map(({ at: _at, ...rest }) => {
    void _at;
    return rest as WhyEvent;
  });
  return { events: kept, truncated: sorted.length > WHY_MAX_EVENTS };
}

/** Sent with the events, so the rule sits next to the data it governs. */
export const WHY_LEGEND =
  "Each event says WHAT happened, WHEN (South African time) and its CAUSE as the record states it: \"person: <name>\" — that person did it; \"automatic: <name>\" — the CRM did it on its own (journey engine, chatbot, lead routing, customer portal, website); \"journey \\\"X\\\"\" — sent or done by that journey; \"the customer\" — their own action; \"filed under <name> or an automatic entry\" — NOT certain: say it is under that name and may have been automatic; \"not recorded\" — the CRM does not record the cause, so SAY SO rather than guessing. " +
  "Answer a \"why\" from these events: name the cause and cite the event (its date). Anything you infer beyond them (e.g. a likely reason a customer went quiet) is \"My read:\", never a fact. If no event explains it, say the CRM does not record why.";

/**
 * HOW DAX'S SUGGESTIONS WORKED OUT — step 1 of outcome tracking (Sean, 2026-11-02, "Build what you suggest";
 * docs/dax-suggestions-2026-11-02.md, build 4): MEASURE and SHOW. Nothing here changes what DAX suggests.
 *
 * Pure, so it is tested without a database: the family each kind of card counts in, the kind of each recorded
 * Confirm, and what happened after it — read from records the CRM keeps anyway (assistantOutcomes.ts loads them
 * for Settings → Assistant).
 *
 * WHAT HAPPENED AFTER, NOT WHAT DAX CAUSED: the customer may well have replied anyway. The page says so.
 */
import type { ActionCard } from "./assistantActions";

type Kind = ActionCard["kind"];
export type Outcome = "reply" | "quote" | "progress";

const DAY_MS = 86_400_000;
/** How long after a Confirm still counts as "after". */
const WINDOW_DAYS: Record<Outcome, number> = { reply: 3, quote: 14, progress: 14 };

export const OUTCOME_LABELS: Record<Outcome, string> = {
  reply: "Customer replied within 3 days",
  quote: "Quote accepted or signed within 14 days",
  progress: "Deal moved forward or was won within 14 days",
};

/** The families shown, in this order. A kind not listed — a new card included — counts under Other, with no outcome. */
export const FAMILIES: readonly { key: string; label: string; kinds: readonly Kind[]; outcome: Outcome | null }[] = [
  { key: "follow_ups", label: "Follow-ups & reminders", kinds: ["follow_up", "reschedule"], outcome: "reply" },
  { key: "messages", label: "Messages drafted", kinds: ["draft_message"], outcome: "reply" },
  { key: "notes", label: "Notes", kinds: ["note", "customer_note"], outcome: "reply" },
  { key: "stage", label: "Stage & assignment", kinds: ["stage", "assign"], outcome: "progress" },
  { key: "quotes", label: "Quotes", kinds: ["quote", "quote_build", "quote_add", "quote_change", "quote_pdf"], outcome: "quote" },
  { key: "meetings", label: "Meetings & test drives", kinds: ["meeting", "test_drive"], outcome: "reply" },
  { key: "other", label: "Other", kinds: [], outcome: null },
];

export function familyOf(kind: string | null): (typeof FAMILIES)[number] {
  return FAMILIES.find((family) => (family.kinds as readonly string[]).includes(kind ?? "")) ?? FAMILIES[FAMILIES.length - 1];
}

/**
 * The audit events that record a Confirm of one of DAX's cards. Every card's Confirm writes
 * assistant.action_confirmed (runAssistantAction) — except a drafted message, whose Confirm is its Send
 * (assistant.draft_sent), and a schedule or a watch, recorded as created (only ever from a card).
 */
export const CONFIRM_EVENTS = ["assistant.action_confirmed", "assistant.draft_sent", "assistant.schedule_created", "assistant.watch_created"];

const CONFIRMED = "Confirmed the assistant's proposal: ";
/** Every wording runAssistantAction has written since it began (git history, 2026-11-02). */
const SUMMARY_KINDS: [RegExp, Kind][] = [
  [/^schedule an? /, "follow_up"],
  [/^add a note\b/, "note"],
  [/^add a new customer$/, "create_customer"],
  [/^open a lead$/, "create_lead"],
  [/^file a document$/, "attach_file"],
  [/^record (the deposit|a payment)$/, "record_payment"],
  [/^update the customer's details$/, "update_customer"],
  [/^give the lead to /, "assign"],
  [/^move the lead to another stage$/, "stage"],
  [/^book a meeting$/, "meeting"],
  [/^book a test drive$/, "test_drive"],
  [/^open job card #/, "job_card"],
  [/^block time on their own calendar$/, "block_time"],
  [/^reschedule an activity$/, "reschedule"],
  [/^cancel an activity$/, "cancel_activity"],
  [/^mark the deal lost$/, "lost"],
  [/^start a quote$/, "quote"],
  [/^create draft quote /, "quote_build"],
  [/^send me the PDF of quote /, "quote_pdf"],
  [/^change draft quote /, "quote_change"],
  [/^add to draft quote /, "quote_add"],
];

/** A Confirm recorded before the card's kind was (metadata.kind, 2026-11-02): read back from its summary. Unknown: null (Other). */
export function kindFromSummary(summary: string): Kind | null {
  if (!summary.startsWith(CONFIRMED)) return null;
  const what = summary.slice(CONFIRMED.length);
  return SUMMARY_KINDS.find(([pattern]) => pattern.test(what))?.[1] ?? null;
}

/** The kind of card a confirm event (CONFIRM_EVENTS) was for. */
export function confirmedKind(event: { eventType: string; summary: string; metadata: unknown }): string | null {
  if (event.eventType === "assistant.draft_sent") return "draft_message";
  if (event.eventType === "assistant.schedule_created") return "schedule";
  if (event.eventType === "assistant.watch_created") return "watch";
  const stamped = event.metadata && typeof event.metadata === "object" ? (event.metadata as { kind?: unknown }).kind : undefined;
  return typeof stamped === "string" ? stamped : kindFromSummary(event.summary);
}

/** What is kept of each card DAX offered (AssistantTurn.proposed): its kind, and the deal or customer it was on — ids, never names. */
export type Proposed = { kind: string; leadId?: string; contactId?: string };

export function proposedCards(cards: readonly ActionCard[]): Proposed[] {
  return cards.map((card) => ({
    kind: card.kind,
    ...("leadId" in card && card.leadId ? { leadId: card.leadId } : {}),
    ...("contactId" in card && card.contactId ? { contactId: card.contactId } : {}),
  }));
}

export function readProposed(value: unknown): Proposed[] {
  return Array.isArray(value)
    ? value.filter((p): p is Proposed => Boolean(p) && typeof p === "object" && typeof (p as Proposed).kind === "string")
    : [];
}

/** Something that happened on a deal and/or a customer. */
export type Happening = { at: Date; leadId: string | null; contactId: string | null };
/** One Confirm: who, which kind, when, and the deal and/or customer it was on (a deal's customer filled in). */
export type Confirmation = Happening & { userId: string | null; kind: string | null };

/** moveLead's lead.stage_changed audit events (before/after { stageId }) → the moves to a later stage. */
export function forwardMoves(
  events: readonly { entityId: string | null; beforeJson: unknown; afterJson: unknown; createdAt: Date }[],
  order: ReadonlyMap<string, number>,
): Happening[] {
  const stageOf = (json: unknown) => order.get(String(json && typeof json === "object" ? (json as { stageId?: unknown }).stageId : ""));
  return events.flatMap((e) => {
    const from = stageOf(e.beforeJson);
    const to = stageOf(e.afterJson);
    return e.entityId && from !== undefined && to !== undefined && to > from ? [{ at: e.createdAt, leadId: e.entityId, contactId: null }] : [];
  });
}

/** Of the Confirms an outcome applies to: it happened, out of those judged; and those too recent to judge yet. */
export type Tally = { happened: number; judged: number; pending: number };
export type FamilyRow = { key: string; label: string; outcome: Outcome | null; suggested: number; confirmed: number; after: Tally };
/** userId null: everyone no longer in the team, together. */
export type PersonRow = { userId: string | null; suggested: number; confirmed: number; replied: Tally };

const empty = (): Tally => ({ happened: 0, judged: 0, pending: 0 });

/**
 * Judged only once its whole window has passed: counting early replies but not early silences would flatter it.
 * A card on no deal or customer (someone's own calendar) has no outcome; a deal move needs a deal.
 */
function verdict(c: Confirmation, outcome: Outcome | null, now: Date, happened: Record<Outcome, readonly Happening[]>): "happened" | "missed" | "pending" | null {
  if (!outcome || !(outcome === "progress" ? c.leadId : c.leadId || c.contactId)) return null;
  const from = c.at.getTime();
  const until = from + WINDOW_DAYS[outcome] * DAY_MS;
  if (until > now.getTime()) return "pending";
  const same = (h: Happening) =>
    outcome === "progress"
      ? h.leadId === c.leadId
      : (c.leadId !== null && h.leadId === c.leadId) || (c.contactId !== null && h.contactId === c.contactId);
  // ponytail: a scan per Confirm — the lists are already bounded to the period and the records confirmed on.
  return happened[outcome].some((h) => h.at.getTime() > from && h.at.getTime() <= until && same(h)) ? "happened" : "missed";
}

export function summarizeOutcomes(input: {
  now: Date;
  proposals: readonly (Proposed & { userId: string })[];
  confirmations: readonly Confirmation[];
  happened: Record<Outcome, readonly Happening[]>;
  /** What the viewer may open (null: everything). A card on no record — someone's own calendar — always counts. */
  visible: { leads: ReadonlySet<string> | null; contacts: ReadonlySet<string> | null };
  /** The workspace's people: anyone else is counted as no longer in the team. */
  staffIds: ReadonlySet<string>;
}): { families: FamilyRow[]; people: PersonRow[] } {
  const { leads, contacts } = input.visible;
  const mayOpen = (r: { leadId?: string | null; contactId?: string | null }) =>
    r.leadId ? !leads || leads.has(r.leadId) : r.contactId ? !contacts || contacts.has(r.contactId) : true;
  const families: FamilyRow[] = FAMILIES.map((f) => ({ key: f.key, label: f.label, outcome: f.outcome, suggested: 0, confirmed: 0, after: empty() }));
  const rowOf = (kind: string | null) => families[FAMILIES.indexOf(familyOf(kind))];
  const people = new Map<string | null, PersonRow>();
  const person = (userId: string | null) => {
    const key = userId && input.staffIds.has(userId) ? userId : null;
    const row = people.get(key) ?? { userId: key, suggested: 0, confirmed: 0, replied: empty() };
    people.set(key, row);
    return row;
  };
  const count = (tally: Tally, v: "happened" | "missed" | "pending") => {
    if (v === "pending") tally.pending++;
    else {
      tally.judged++;
      if (v === "happened") tally.happened++;
    }
  };

  for (const p of input.proposals) {
    if (!mayOpen(p)) continue;
    rowOf(p.kind).suggested++;
    person(p.userId).suggested++;
  }
  for (const c of input.confirmations) {
    if (!mayOpen(c)) continue;
    const row = rowOf(c.kind);
    const who = person(c.userId);
    row.confirmed++;
    who.confirmed++;
    const v = verdict(c, row.outcome, input.now, input.happened);
    if (!v) continue;
    count(row.after, v);
    if (row.outcome === "reply") count(who.replied, v);
  }
  return {
    families,
    // Busiest first; the former team last.
    people: [...people.values()].sort((a, b) => Number(a.userId === null) - Number(b.userId === null) || b.confirmed - a.confirmed || b.suggested - a.suggested),
  };
}

export function percent(part: number, whole: number): string {
  return `${Math.min(100, Math.round((100 * part) / whole))}%`;
}

/** "4 of 7 (57%) · 2 too recent to tell", as the page shows a Tally. */
export function describeTally(t: Tally): string {
  const recent = t.pending ? `${t.pending} too recent to tell` : "";
  if (!t.judged) return recent || "—";
  return `${t.happened} of ${t.judged} (${percent(t.happened, t.judged)})${recent ? ` · ${recent}` : ""}`;
}

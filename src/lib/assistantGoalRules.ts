/**
 * DAX GOALS — "keep an eye on this delivery until it's done" (roadmap Phase 4b, 2026-10-27).
 * The PURE half: the steps a delivery goes through, which one is holding it up, when it has stalled, and what
 * the person is told. No database and no model — the assistant cron (assistantGoals.ts) loads the facts from the
 * CRM, runs evaluateGoal under the goal's row lock, and saves what it returns.
 *
 * Delivery only. "Quote → signed" is the next kind; there is no general condition language until a third needs it.
 *
 * NEVER CONTACTS THE CUSTOMER. Every alert goes to the person who set the goal. Where the customer needs a nudge
 * (a deposit not in), the alert says which screen to do it from — the person clicks; DAX never sends.
 */

/** A goal is an AssistantTask of this kind; its state lives in `details` (GoalState). */
export const GOAL_KIND = "delivery_goal";

export const GOAL_STEPS = ["deposit", "documents", "prep", "booking", "delivered"] as const;
export type GoalStep = (typeof GOAL_STEPS)[number];

/** What each step means, as the sheet lists it once it is done. */
export const STEP_DONE: Record<GoalStep, string> = {
  deposit: "Deposit paid",
  documents: "Invoice issued",
  prep: "Cart allocated and PDI passed",
  booking: "Delivery booked",
  delivered: "Delivered",
};

/** How long a step may hold the delivery up before DAX says it has stalled. */
export const STALL_DAYS: Record<Exclude<GoalStep, "delivered">, number> = { deposit: 3, documents: 2, prep: 5, booking: 3 };
/** Booked but not handed over: stalled once the booked day is this far behind. */
export const OVERDUE_HOURS = 24;
/** Alert keys remembered per goal (each is news once). */
const TOLD_MAX = 30;

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** What the cron read from the CRM, as of now. */
export type GoalFacts = {
  /** "Q-1042" */
  ref: string;
  depositPaid: boolean;
  invoiced: boolean;
  /** The carts allocated to this deal (sold or reserved), with their pre-delivery inspection status. */
  stock: { pdiStatus: string }[];
  deliveryScheduledFor: Date | null;
  delivered: boolean;
  /** The deal was lost, or the quote declined or cancelled. */
  lost: boolean;
};

/** Stored on the goal (AssistantTask.details). */
export type GoalState = {
  /** The step holding the delivery up when last checked; null before the first check. */
  blocker: GoalStep | null;
  /** When that step became the blocker (ISO). */
  since: string;
  /** Alert keys already raised — each is news once. */
  told: string[];
  /** "Off" on the Ask page: not checked, nothing sent, until switched back on. */
  paused?: boolean;
  /** Last cron check (ISO) — a second, overlapping pass finds it fresh and does nothing. */
  checkedAt?: string;
};

export type GoalAlert = { key: string; text: string };
export type GoalEval = {
  outcome: "open" | "done" | "lost";
  state: GoalState;
  /** New alerts only (not in state.told before). */
  alerts: GoalAlert[];
  next: string;
  done: string[];
  outstanding: string[];
};

const PDI_DONE = new Set(["passed", "ready_for_delivery"]);

export function stepDone(step: GoalStep, f: GoalFacts): boolean {
  switch (step) {
    case "deposit": return f.depositPaid;
    case "documents": return f.invoiced;
    // The deal page's own rule: carts allocated, and every one through its PDI.
    case "prep": return f.stock.length > 0 && f.stock.every((s) => PDI_DONE.has(s.pdiStatus));
    case "booking": return Boolean(f.deliveryScheduledFor);
    case "delivered": return f.delivered;
  }
}

/** The first step not done, in order — what holds the delivery up. Null once it is delivered. */
export function nextBlocker(f: GoalFacts): GoalStep | null {
  return GOAL_STEPS.find((s) => !stepDone(s, f)) ?? null;
}

const saDay = (d: Date) =>
  d.toLocaleDateString("en-ZA", { timeZone: "Africa/Johannesburg", weekday: "short", day: "numeric", month: "short" });

/** "the deposit", "the PDI" — what is outstanding, in words. */
export function blockerText(step: GoalStep, f: GoalFacts): string {
  switch (step) {
    case "deposit": return "the deposit";
    case "documents": return "the invoice";
    case "prep": return f.stock.length ? "the PDI on the cart" : "a cart to be allocated";
    case "booking": return "a delivery date";
    case "delivered": return f.deliveryScheduledFor ? `the handover (booked for ${saDay(f.deliveryScheduledFor)})` : "the handover";
  }
}

/** Where the person does it — the CRM's own screen. The customer side is always theirs to click, never DAX's. */
function whatToDo(step: GoalStep): string {
  switch (step) {
    case "deposit": return "If the customer needs a nudge, message them from the deal — I won't contact them. Mark it paid on the Deliveries board once it's in.";
    case "documents": return "Issue the invoice on the Deliveries board.";
    case "prep": return "Allocate the cart and complete its PDI on the Stock page.";
    case "booking": return "Book the delivery on the Deliveries board.";
    case "delivered": return "Mark it delivered on the Deliveries board once it's handed over, or rebook it.";
  }
}

/**
 * One check. `prev` is what the goal held; the result is what to save and what is NEWS: the next blocker when
 * the delivery moved on, a stall once per stall, and done or lost. Nothing already told is told again.
 */
export function evaluateGoal(prev: GoalState, f: GoalFacts, now: Date): GoalEval {
  const done = GOAL_STEPS.filter((s) => stepDone(s, f)).map((s) => STEP_DONE[s]);
  const outstanding = GOAL_STEPS.filter((s) => !stepDone(s, f)).map((s) => STEP_DONE[s]);
  const finish = (outcome: "done" | "lost", key: string, text: string, next: string): GoalEval => {
    const fresh = prev.told.includes(key) ? [] : [{ key, text }];
    return { outcome, state: { ...prev, told: [...prev.told, ...fresh.map((a) => a.key)].slice(-TOLD_MAX) }, alerts: fresh, next, done, outstanding };
  };
  // Delivered wins over lost: a cart handed over is done, whatever the deal's status says.
  if (f.delivered) return finish("done", "done", `✅ ${f.ref} is delivered — that goal is done, and I've stopped following it.`, "Delivered");
  if (f.lost) return finish("lost", "lost", `🛑 ${f.ref}: the deal is lost, so I've stopped following its delivery.`, "Deal lost");

  const blocker = nextBlocker(f) ?? "delivered";
  const since = blocker === prev.blocker ? prev.since : now.toISOString();
  const alerts: GoalAlert[] = [];
  // Moved on since the last check (not the first check — the person was told the blocker when they set it up).
  if (prev.blocker !== null && blocker !== prev.blocker) {
    alerts.push({ key: `next:${blocker}:${since}`, text: `🚚 ${f.ref} moved on. Next: ${blockerText(blocker, f)}. ${whatToDo(blocker)}` });
  }
  if (blocker === "delivered") {
    const booked = f.deliveryScheduledFor;
    if (booked && now.getTime() - booked.getTime() > OVERDUE_HOURS * HOUR) {
      alerts.push({ key: `stall:delivered:${booked.toISOString()}`, text: `⏳ ${f.ref} was booked for ${saDay(booked)} and isn't marked delivered. ${whatToDo(blocker)}` });
    }
  } else {
    const waited = Math.floor((now.getTime() - new Date(since).getTime()) / DAY);
    if (waited >= STALL_DAYS[blocker]) {
      alerts.push({ key: `stall:${blocker}:${since}`, text: `⏳ ${f.ref} has been waiting on ${blockerText(blocker, f)} for ${waited} days. ${whatToDo(blocker)}` });
    }
  }
  const fresh = alerts.filter((a) => !prev.told.includes(a.key));
  return {
    outcome: "open",
    state: { ...prev, blocker, since, told: [...prev.told, ...fresh.map((a) => a.key)].slice(-TOLD_MAX) },
    alerts: fresh,
    next: `Waiting on ${blockerText(blocker, f)}`,
    done,
    outstanding,
  };
}

/** The goal's first state, when the person sets it: the blocker as it stands, nothing told yet. */
export function startState(f: GoalFacts, now: Date): GoalState {
  return { blocker: nextBlocker(f) ?? "delivered", since: now.toISOString(), told: [] };
}

/** Stored JSON → state, tolerating anything malformed (it reads as a fresh goal, never throws). */
export function readGoalState(raw: unknown, now: Date): GoalState {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Partial<GoalState>) : {};
  return {
    blocker: GOAL_STEPS.includes(o.blocker as GoalStep) ? (o.blocker as GoalStep) : null,
    since: typeof o.since === "string" && !Number.isNaN(Date.parse(o.since)) ? o.since : now.toISOString(),
    told: Array.isArray(o.told) ? o.told.map(String).slice(-TOLD_MAX) : [],
    ...(o.paused ? { paused: true } : {}),
    ...(typeof o.checkedAt === "string" ? { checkedAt: o.checkedAt } : {}),
  };
}

/** The DAX check-backs a goal owns: the person's own DAX-set check-backs that name this quote ("…Q-1042…"). */
export function namesQuote(text: string | null | undefined, quoteNumber: number): boolean {
  return Boolean(text) && new RegExp(`\\bQ-?${quoteNumber}(?!\\d)`, "i").test(text!);
}

/** What the done / lost note adds about the reminders it switched off. */
export function remindersOffText(watches: number, checkBacks: number): string {
  const parts = [
    watches ? `${watches} watch${watches === 1 ? "" : "es"}` : "",
    checkBacks ? `${checkBacks} check-back${checkBacks === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return parts.length ? ` I've also switched off ${parts.join(" and ")} about it — they no longer matter.` : "";
}

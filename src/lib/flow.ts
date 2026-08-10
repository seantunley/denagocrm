/**
 * Channel-agnostic chatbot flow engine. The graph remains deterministic: AI can
 * answer or classify, but every CRM/Journey side effect is an explicit node
 * executed through a narrow callback supplied by the channel adapter.
 */

export type FlowOption = { id: string; label: string; description?: string; next?: string };
export type CaptureFormat = "text" | "email" | "phone" | "number" | "date";
export type ConditionOperator = "equals" | "not_equals" | "contains" | "exists" | "empty";
export type FlowCondition = { variable: string; operator: ConditionOperator; value?: string };
export type BookingCreateAction = "service" | "demo" | "lead";
export type BookingManageAction = "lookup" | "cancel";
export type BookingAction = BookingCreateAction | BookingManageAction;
export type SlotAction = "book" | "reschedule";

/**
 * What a side-effecting action actually did.
 *
 * `unavailable` is a THIRD state, not a flavour of failure: "there are no
 * appointments left" is a valid request the business cannot satisfy right now,
 * while "the reservation failed" is a system/business failure. They deserve
 * different words to the customer, so the graph routes them separately.
 */
export type ActionOutcome = { ok: boolean; unavailable?: boolean; reason?: string };

export type FlowNode =
  | { id: string; type: "message"; text: string; next?: string }
  | { id: string; type: "choice"; text: string; options: FlowOption[] }
  | { id: string; type: "capture"; text: string; variable: string; format?: CaptureFormat; next?: string }
  | { id: string; type: "captureFile"; text: string; variable: string; next?: string }
  | { id: string; type: "image"; url: string; caption?: string; next?: string }
  | { id: string; type: "answer"; text?: string; answerSource?: "pricelist" | "colours"; next?: string }
  | { id: string; type: "booking"; text?: string; failureText?: string; action?: BookingAction; next?: string; failureNext?: string; unavailableNext?: string }
  | { id: string; type: "slots"; text: string; noneText?: string; failureText?: string; action?: SlotAction; next?: string; failureNext?: string; unavailableNext?: string }
  | { id: string; type: "journey"; journeyId: string; text?: string; failureText?: string; next?: string; failureNext?: string; unavailableNext?: string }
  | { id: string; type: "condition"; condition: FlowCondition; trueNext?: string; falseNext?: string }
  | { id: string; type: "ai"; handoffNext?: string }
  | { id: string; type: "handoff"; text?: string }
  | { id: string; type: "end" };

export type Flow = { start: string; nodes: Record<string, FlowNode> };
export type OutMsg =
  | { type: "text"; text: string }
  | { type: "image"; url: string; caption?: string }
  | { type: "choice"; text: string; options: { id: string; label: string; description?: string }[] };
export type FlowSession = { nodeId: string | null; vars: Record<string, string> };
export type FlowInput = { text: string; choiceId?: string; fileUrl?: string };

export type FlowAiReply = {
  reply: string;
  handoff: boolean;
  confidence?: "high" | "medium" | "low";
  intent?: string;
  handoffReason?: string;
  handoffSummary?: string;
};
export type FlowHandoffContext = { confidence?: "high" | "medium" | "low"; intent?: string; reason?: string; summary?: string };

export type FlowCtx = {
  aiReply: (vars: Record<string, string>) => Promise<FlowAiReply>;
  dynamicAnswer: (source: "pricelist" | "colours") => Promise<string>;
  createBooking: (vars: Record<string, string>, action: BookingCreateAction | undefined, nodeId: string) => Promise<ActionOutcome>;
  manageBooking?: (action: BookingManageAction, vars: Record<string, string>, nodeId: string) => Promise<ActionOutcome>;
  startJourney?: (journeyId: string, vars: Record<string, string>, nodeId: string) => Promise<{ ok: boolean; reason?: string }>;
  handoff: (vars: Record<string, string>, context?: FlowHandoffContext) => Promise<void>;
  availableSlots?: () => Promise<{ id: string; label: string }[]>;
  bookSlot?: (slotId: string, vars: Record<string, string>, nodeId: string) => Promise<{ ok: boolean; label?: string }>;
  rescheduleSlot?: (slotId: string, vars: Record<string, string>, nodeId: string) => Promise<{ ok: boolean; label?: string }>;
  routeChoice?: (input: { prompt: string; text: string; options: FlowOption[]; vars: Record<string, string> }) => Promise<string | null>;
  /** Pure observation hook; runners persist this in the analytics ledger. */
  recordAction?: (nodeId: string, action: string, ok: boolean) => void;
};

const FORMAT_RE: Record<string, RegExp> = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  phone: /^\+?[\d\s()-]{7,}$/,
  number: /^\d+$/,
  date: /\d/,
};
function validateCapture(format: CaptureFormat | undefined, text: string): boolean {
  if (!format || format === "text") return text.trim().length > 0;
  return FORMAT_RE[format]?.test(text.trim()) ?? true;
}

export type FlowResult = { messages: OutMsg[]; session: FlowSession | null; handedOff: boolean };
const interpolate = (text: string, vars: Record<string, string>) => text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => vars[k] ?? "");

export function evaluateCondition(condition: FlowCondition, vars: Record<string, string>): boolean {
  const actual = (vars[condition.variable] ?? "").trim();
  const expected = (condition.value ?? "").trim();
  switch (condition.operator) {
    case "exists": return actual.length > 0;
    case "empty": return actual.length === 0;
    case "contains": return actual.toLocaleLowerCase().includes(expected.toLocaleLowerCase());
    case "not_equals": return actual.toLocaleLowerCase() !== expected.toLocaleLowerCase();
    default: return actual.toLocaleLowerCase() === expected.toLocaleLowerCase();
  }
}

const HANDOFF_KEYS = { confidence: "__handoff_confidence", intent: "__handoff_intent", reason: "__handoff_reason", summary: "__handoff_summary" } as const;
function rememberHandoff(vars: Record<string, string>, ai: FlowAiReply): FlowHandoffContext {
  const context: FlowHandoffContext = { confidence: ai.confidence, intent: ai.intent, reason: ai.handoffReason, summary: ai.handoffSummary };
  if (context.confidence) vars[HANDOFF_KEYS.confidence] = context.confidence;
  if (context.intent) vars[HANDOFF_KEYS.intent] = context.intent;
  if (context.reason) vars[HANDOFF_KEYS.reason] = context.reason;
  if (context.summary) vars[HANDOFF_KEYS.summary] = context.summary;
  return context;
}
function rememberedHandoff(vars: Record<string, string>): FlowHandoffContext | undefined {
  const confidence = vars[HANDOFF_KEYS.confidence];
  const context: FlowHandoffContext = {
    confidence: confidence === "high" || confidence === "medium" || confidence === "low" ? confidence : undefined,
    intent: vars[HANDOFF_KEYS.intent] || undefined,
    reason: vars[HANDOFF_KEYS.reason] || undefined,
    summary: vars[HANDOFF_KEYS.summary] || undefined,
  };
  return context.confidence || context.intent || context.reason || context.summary ? context : undefined;
}

export const choiceId = (nodeId: string, optId: string) => `${nodeId}|${optId}`;
function matchChoice(node: Extract<FlowNode, { type: "choice" }>, input: FlowInput): string | null {
  if (input.choiceId && input.choiceId.startsWith(`${node.id}|`)) {
    const optId = input.choiceId.slice(node.id.length + 1);
    return node.options.find((o) => o.id === optId)?.next ?? null;
  }
  const t = input.text.trim().toLowerCase();
  const asNum = parseInt(t, 10);
  if (!Number.isNaN(asNum) && node.options[asNum - 1]) return node.options[asNum - 1].next ?? null;
  return node.options.find((o) => t && o.label.toLowerCase().replace(/[^a-z0-9 ]/g, "").includes(t))?.next ?? null;
}
async function semanticChoice(node: Extract<FlowNode, { type: "choice" }>, input: FlowInput, vars: Record<string, string>, ctx: FlowCtx) {
  if (!ctx.routeChoice || input.choiceId || !input.text.trim()) return null;
  const optionId = await ctx.routeChoice({ prompt: interpolate(node.text, vars), text: input.text, options: node.options, vars });
  return optionId ? node.options.find((o) => o.id === optionId)?.next ?? null : null;
}

async function runSlotSelection(node: Extract<FlowNode, { type: "slots" }>, input: FlowInput, vars: Record<string, string>, ctx: FlowCtx, messages: OutMsg[]) {
  const slotAction = node.action === "reschedule" ? "booking_reschedule" : "slot_booking";

  // `next` is reachable ONLY after a reservation actually succeeded.
  //
  // This used to advance to `next` when the customer typed instead of tapping —
  // so someone looking at the slot menu who replied "9am please" was sent straight
  // to "You're booked…" with no booking made. A stale or malformed callback id did
  // the same. Re-offer the times and keep waiting instead: an unparsed reply is
  // not a selection.
  if (!input.choiceId?.startsWith(`${node.id}|`)) {
    const opts = ctx.availableSlots ? await ctx.availableSlots() : [];
    if (!opts.length) {
      messages.push({ type: "text", text: node.noneText || "We don't have open slots online right now — leave your details and the team will call you to book. 📞" });
      return { nodeId: node.unavailableNext ?? node.failureNext ?? null };
    }
    messages.push({ type: "choice", text: interpolate(node.text, vars), options: opts.map((o) => ({ id: choiceId(node.id, o.id), label: o.label })) });
    return { nodeId: node.id, wait: { messages, session: { nodeId: node.id, vars }, handedOff: false } as FlowResult };
  }

  const slotId = input.choiceId.slice(node.id.length + 1);
  const handler = node.action === "reschedule" ? ctx.rescheduleSlot : ctx.bookSlot;
  const action = slotAction;
  // The channel adapter did not supply a reservation handler, so nothing can be
  // booked. Fail closed rather than reporting success for an action that never ran.
  if (!handler) {
    ctx.recordAction?.(node.id, slotAction, false);
    if (node.failureText) messages.push({ type: "text", text: interpolate(node.failureText, vars) });
    return { nodeId: node.failureNext ?? null };
  }
  const res = await handler(slotId, vars, node.id);
  ctx.recordAction?.(node.id, action, res.ok);
  if (!res.ok) {
    const opts = ctx.availableSlots ? await ctx.availableSlots() : [];
    if (opts.length) {
      messages.push({ type: "choice", text: "That one just filled up — here are the next open times:", options: opts.map((o) => ({ id: choiceId(node.id, o.id), label: o.label })) });
      return { nodeId: node.id, wait: { messages, session: { nodeId: node.id, vars }, handedOff: false } as FlowResult };
    }
    // No alternatives left, and the reservation failed. Falling through to `next`
    // sent the customer the success text — "You're booked" — for a slot that was
    // taken between showing the menu and their tap.
    if (node.failureText) messages.push({ type: "text", text: interpolate(node.failureText, vars) });
    return { nodeId: node.failureNext ?? null };
  } else if (res.label) {
    vars.slot = res.label;
    if (node.action === "reschedule") vars.booking_slot = res.label;
  }
  return { nodeId: node.next ?? null };
}

/**
 * Where a side-effecting node goes, and what it says, once its action has either
 * worked or not.
 *
 * Both used to be unconditional: the node sent its text and moved to `next`
 * whatever happened. So a failed cancellation still said "Done — your booking has
 * been cancelled", and a Journey that refused to start still said it had. Telling
 * a customer an action succeeded when it did not is the worst failure this engine
 * can produce — worse than an error, because they act on it.
 *
 * `failureNext` is optional so existing graphs keep working; without one the node
 * still advances, but it stays silent rather than claiming success.
 */
function actionOutcome(
  node: { text?: string; failureText?: string; next?: string; failureNext?: string; unavailableNext?: string },
  outcome: ActionOutcome,
  vars: Record<string, string>,
  messages: OutMsg[],
): string | null {
  if (outcome.ok) {
    if (node.text) messages.push({ type: "text", text: interpolate(node.text, vars) });
    return node.next ?? null;
  }
  if (node.failureText) messages.push({ type: "text", text: interpolate(node.failureText, vars) });
  // A failed action NEVER falls back to `next`. That fallback is precisely how a
  // customer was told "Done — your booking has been cancelled" for a cancellation
  // that did not happen. With no route defined the turn simply ends: saying
  // nothing is recoverable, claiming success is not. The publish compiler refuses
  // a new graph that leaves this undefined.
  const route = outcome.unavailable ? node.unavailableNext ?? node.failureNext : node.failureNext;
  return route ?? null;
}

export async function runFlow(flow: Flow, session: FlowSession, input: FlowInput, ctx: FlowCtx): Promise<FlowResult> {
  const messages: OutMsg[] = [];
  const vars = { ...session.vars };
  let nodeId: string | null;
  let handoffContext = rememberedHandoff(vars);

  if (session.nodeId) {
    const cur = flow.nodes[session.nodeId];
    if (cur?.type === "choice") {
      nodeId = matchChoice(cur, input);
      if (!nodeId) nodeId = await semanticChoice(cur, input, vars, ctx);
      if (!nodeId) {
        messages.push({ type: "choice", text: interpolate(cur.text, vars), options: cur.options.map((o) => ({ id: choiceId(cur.id, o.id), label: o.label, description: o.description })) });
        return { messages, session: { nodeId: cur.id, vars }, handedOff: false };
      }
    } else if (cur?.type === "capture") {
      if (!validateCapture(cur.format, input.text)) {
        const hint = cur.format === "email" ? " (please enter a valid email)" : cur.format === "phone" ? " (please enter a valid phone number)" : cur.format === "number" ? " (please enter a number)" : "";
        messages.push({ type: "text", text: interpolate(cur.text, vars) + hint });
        return { messages, session: { nodeId: cur.id, vars }, handedOff: false };
      }
      vars[cur.variable] = input.text.trim();
      nodeId = cur.next ?? null;
    } else if (cur?.type === "captureFile") {
      if (!input.fileUrl) {
        messages.push({ type: "text", text: interpolate(cur.text, vars) + " (please attach a photo or file)" });
        return { messages, session: { nodeId: cur.id, vars }, handedOff: false };
      }
      vars[cur.variable] = input.fileUrl;
      nodeId = cur.next ?? null;
    } else if (cur?.type === "slots") {
      const selected = await runSlotSelection(cur, input, vars, ctx, messages);
      if (selected.wait) return selected.wait;
      nodeId = selected.nodeId;
    } else if (cur?.type === "ai") {
      const ai = await ctx.aiReply(vars);
      messages.push({ type: "text", text: ai.reply });
      if (ai.handoff) {
        handoffContext = rememberHandoff(vars, ai);
        nodeId = cur.handoffNext ?? null;
        if (!nodeId) { await ctx.handoff(vars, handoffContext); return { messages, session: null, handedOff: true }; }
      } else return { messages, session: { nodeId: cur.id, vars }, handedOff: false };
    } else nodeId = flow.start;
  } else nodeId = flow.start;

  let guard = 0;
  while (nodeId && guard++ < 50) {
    const node = flow.nodes[nodeId];
    if (!node) break;
    if (node.type === "message") {
      messages.push({ type: "text", text: interpolate(node.text, vars) }); nodeId = node.next ?? null;
    } else if (node.type === "image") {
      messages.push({ type: "image", url: node.url, caption: node.caption ? interpolate(node.caption, vars) : undefined }); nodeId = node.next ?? null;
    } else if (node.type === "captureFile") {
      messages.push({ type: "text", text: interpolate(node.text, vars) }); return { messages, session: { nodeId: node.id, vars }, handedOff: false };
    } else if (node.type === "answer") {
      const text = node.answerSource ? await ctx.dynamicAnswer(node.answerSource) : interpolate(node.text ?? "", vars); if (text) messages.push({ type: "text", text }); nodeId = node.next ?? null;
    } else if (node.type === "booking") {
      // An action that FAILED must not fall through to the success text. The
      // shipped cancellation node says "Done — your booking has been cancelled",
      // and it used to say that whether or not anything was cancelled. Telling a
      // customer their booking is gone when it is not is worse than any error.
      let outcome: ActionOutcome;
      if (node.action === "lookup" || node.action === "cancel") {
        outcome = ctx.manageBooking
          ? await ctx.manageBooking(node.action, vars, node.id)
          : { ok: false, reason: "Booking management is unavailable" };
        // The lookup result drives the route too. It was previously discarded, so a
        // lookup that found nothing — or refused an unidentified customer — still
        // continued down the success branch and relied on later condition nodes to
        // catch it. That made the ENGINE unsafe even where the template was not.
        ctx.recordAction?.(node.id, `booking_${node.action}`, outcome.ok);
      } else {
        outcome = await ctx.createBooking(vars, node.action, node.id);
        ctx.recordAction?.(node.id, `booking_${node.action ?? "service"}`, outcome.ok);
      }
      nodeId = actionOutcome(node, outcome, vars, messages);
    } else if (node.type === "journey") {
      const outcome = ctx.startJourney ? await ctx.startJourney(node.journeyId, vars, node.id) : { ok: false, reason: "Journey action unavailable" };
      ctx.recordAction?.(node.id, "journey_start", outcome.ok);
      if (!vars.journey_started) vars.journey_started = outcome.ok ? "yes" : "no";
      if (outcome.reason && !vars.journey_reason) vars.journey_reason = outcome.reason;
      nodeId = actionOutcome(node, outcome, vars, messages);
    } else if (node.type === "slots") {
      const opts = ctx.availableSlots ? await ctx.availableSlots() : [];
      // No slots is NOT the success path. It used to fall through to `next`, whose
      // shipped text is "You're booked, {{name}}!" — after a turn in which nothing
      // was booked at all.
      if (!opts.length) { messages.push({ type: "text", text: node.noneText || "We don't have open slots online right now — leave your details and the team will call you to book. 📞" }); nodeId = node.unavailableNext ?? node.failureNext ?? null; }
      else { messages.push({ type: "choice", text: interpolate(node.text, vars), options: opts.map((o) => ({ id: choiceId(node.id, o.id), label: o.label })) }); return { messages, session: { nodeId: node.id, vars }, handedOff: false }; }
    } else if (node.type === "choice") {
      messages.push({ type: "choice", text: interpolate(node.text, vars), options: node.options.map((o) => ({ id: choiceId(node.id, o.id), label: o.label, description: o.description })) }); return { messages, session: { nodeId: node.id, vars }, handedOff: false };
    } else if (node.type === "capture") {
      messages.push({ type: "text", text: interpolate(node.text, vars) }); return { messages, session: { nodeId: node.id, vars }, handedOff: false };
    } else if (node.type === "condition") {
      nodeId = evaluateCondition(node.condition, vars) ? node.trueNext ?? null : node.falseNext ?? null;
    } else if (node.type === "ai") {
      const ai = await ctx.aiReply(vars); messages.push({ type: "text", text: ai.reply });
      if (ai.handoff) { handoffContext = rememberHandoff(vars, ai); nodeId = node.handoffNext ?? null; if (!nodeId) { await ctx.handoff(vars, handoffContext); return { messages, session: null, handedOff: true }; } }
      else return { messages, session: { nodeId: node.id, vars }, handedOff: false };
    } else if (node.type === "handoff") {
      if (node.text) messages.push({ type: "text", text: interpolate(node.text, vars) }); await ctx.handoff(vars, handoffContext); return { messages, session: null, handedOff: true };
    } else return { messages, session: null, handedOff: false };
  }
  return { messages, session: null, handedOff: false };
}

export const DEFAULT_FLOW: Flow = {
  start: "welcome",
  nodes: {
    welcome: { id: "welcome", type: "choice", text: "{{greeting}} How can we help today?", options: [
      { id: "prices", label: "💰 Prices", next: "showPrices" }, { id: "book", label: "🔧 Book a service", next: "bookName" }, { id: "chat", label: "💬 Chat to us", next: "aiChat" },
    ] },
    showPrices: { id: "showPrices", type: "answer", answerSource: "pricelist", next: "afterPrices" },
    afterPrices: { id: "afterPrices", type: "choice", text: "Anything else?", options: [
      { id: "chat", label: "💬 Ask a question", next: "aiChat" }, { id: "menu", label: "🏠 Main menu", next: "welcome" }, { id: "done", label: "👍 No thanks", next: "bye" },
    ] },
    bookName: { id: "bookName", type: "capture", text: "Sure — let's get you booked in. What's your name?", variable: "name", next: "bookPhone" },
    bookPhone: { id: "bookPhone", type: "capture", text: "Thanks {{name}}! What's the best contact number?", variable: "phone", format: "phone", next: "bookService" },
    bookService: { id: "bookService", type: "capture", text: "What does the cart need? (service, repair, etc.)", variable: "service", next: "chooseSlot" },
    chooseSlot: { id: "chooseSlot", type: "slots", action: "book", text: "Here are our next available service times — pick one:", noneText: "We're fully booked online just now — I've logged your request and the team will call you to find a time. 📞", next: "bookConfirm", unavailableNext: "slotHandoff", failureNext: "slotHandoff" },
    slotHandoff: { id: "slotHandoff", type: "handoff", text: "I couldn't hold a time for you — the team will call you to book it." },
    bookConfirm: { id: "bookConfirm", type: "message", text: "You're booked, {{name}}! 🛠 {{slot}}. We'll see you then — message *menu* if anything changes.", next: "end" },
    aiChat: { id: "aiChat", type: "ai" },
    bye: { id: "bye", type: "message", text: "Cheers! Message *menu* any time to start again. 🛺", next: "end" },
    end: { id: "end", type: "end" },
  },
};

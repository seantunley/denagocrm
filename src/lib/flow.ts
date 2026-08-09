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

export type FlowNode =
  | { id: string; type: "message"; text: string; next?: string }
  | { id: string; type: "choice"; text: string; options: FlowOption[] }
  | { id: string; type: "capture"; text: string; variable: string; format?: CaptureFormat; next?: string }
  | { id: string; type: "captureFile"; text: string; variable: string; next?: string }
  | { id: string; type: "image"; url: string; caption?: string; next?: string }
  | { id: string; type: "answer"; text?: string; answerSource?: "pricelist" | "colours"; next?: string }
  | { id: string; type: "booking"; text?: string; action?: BookingAction; next?: string }
  | { id: string; type: "slots"; text: string; noneText?: string; action?: SlotAction; next?: string }
  | { id: string; type: "journey"; journeyId: string; text?: string; next?: string }
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
  createBooking: (vars: Record<string, string>, action: BookingCreateAction | undefined, nodeId: string) => Promise<void>;
  manageBooking?: (action: BookingManageAction, vars: Record<string, string>, nodeId: string) => Promise<{ ok: boolean }>;
  startJourney?: (journeyId: string, vars: Record<string, string>, nodeId: string) => Promise<{ ok: boolean; reason?: string }>;
  handoff: (vars: Record<string, string>, context?: FlowHandoffContext) => Promise<void>;
  availableSlots?: () => Promise<{ id: string; label: string }[]>;
  bookSlot?: (slotId: string, vars: Record<string, string>, nodeId: string) => Promise<{ ok: boolean; label?: string }>;
  rescheduleSlot?: (slotId: string, vars: Record<string, string>, nodeId: string) => Promise<{ ok: boolean; label?: string }>;
  routeChoice?: (input: { prompt: string; text: string; options: FlowOption[]; vars: Record<string, string> }) => Promise<string | null>;
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
  if (!input.choiceId?.startsWith(`${node.id}|`)) return { nodeId: node.next ?? null };
  const slotId = input.choiceId.slice(node.id.length + 1);
  const handler = node.action === "reschedule" ? ctx.rescheduleSlot : ctx.bookSlot;
  if (!handler) return { nodeId: node.next ?? null };
  const res = await handler(slotId, vars, node.id);
  if (!res.ok) {
    const opts = ctx.availableSlots ? await ctx.availableSlots() : [];
    if (opts.length) {
      messages.push({ type: "choice", text: "That one just filled up — here are the next open times:", options: opts.map((o) => ({ id: choiceId(node.id, o.id), label: o.label })) });
      return { nodeId: node.id, wait: { messages, session: { nodeId: node.id, vars }, handedOff: false } as FlowResult };
    }
  } else if (res.label) {
    vars.slot = res.label;
    if (node.action === "reschedule") vars.booking_slot = res.label;
  }
  return { nodeId: node.next ?? null };
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
      if (node.action === "lookup" || node.action === "cancel") { if (ctx.manageBooking) await ctx.manageBooking(node.action, vars, node.id); }
      else await ctx.createBooking(vars, node.action, node.id);
      if (node.text) messages.push({ type: "text", text: interpolate(node.text, vars) }); nodeId = node.next ?? null;
    } else if (node.type === "journey") {
      const outcome = ctx.startJourney ? await ctx.startJourney(node.journeyId, vars, node.id) : { ok: false, reason: "Journey action unavailable" };
      if (!vars.journey_started) vars.journey_started = outcome.ok ? "yes" : "no";
      if (outcome.reason && !vars.journey_reason) vars.journey_reason = outcome.reason;
      if (node.text) messages.push({ type: "text", text: interpolate(node.text, vars) });
      nodeId = node.next ?? null;
    } else if (node.type === "slots") {
      const opts = ctx.availableSlots ? await ctx.availableSlots() : [];
      if (!opts.length) { messages.push({ type: "text", text: node.noneText || "We don't have open slots online right now — leave your details and the team will call you to book. 📞" }); nodeId = node.next ?? null; }
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
    chooseSlot: { id: "chooseSlot", type: "slots", action: "book", text: "Here are our next available service times — pick one:", noneText: "We're fully booked online just now — I've logged your request and the team will call you to find a time. 📞", next: "bookConfirm" },
    bookConfirm: { id: "bookConfirm", type: "message", text: "You're booked, {{name}}! 🛠 {{slot}}. We'll see you then — message *menu* if anything changes.", next: "end" },
    aiChat: { id: "aiChat", type: "ai" },
    bye: { id: "bye", type: "message", text: "Cheers! Message *menu* any time to start again. 🛺", next: "end" },
    end: { id: "end", type: "end" },
  },
};

/**
 * Channel-agnostic chatbot flow engine (Typebot-inspired). A flow is a graph
 * of nodes; the engine walks it, emitting outbound messages and pausing on
 * nodes that wait for the customer (choices, captures, AI). IO (sending,
 * AI, booking, handoff) is provided by the caller via `ctx`.
 */

export type FlowOption = { id: string; label: string; description?: string; next?: string };

export type CaptureFormat = "text" | "email" | "phone" | "number" | "date";

export type FlowNode =
  | { id: string; type: "message"; text: string; next?: string }
  | { id: string; type: "choice"; text: string; options: FlowOption[] }
  | { id: string; type: "capture"; text: string; variable: string; format?: CaptureFormat; next?: string }
  | { id: string; type: "captureFile"; text: string; variable: string; next?: string }
  | { id: string; type: "image"; url: string; caption?: string; next?: string }
  | { id: string; type: "answer"; text?: string; answerSource?: "pricelist" | "colours"; next?: string }
  | { id: string; type: "booking"; text?: string; action?: "service" | "demo" | "lead"; next?: string }
  | { id: string; type: "slots"; text: string; noneText?: string; next?: string }
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

export type FlowCtx = {
  aiReply: (vars: Record<string, string>) => Promise<{ reply: string; handoff: boolean }>;
  dynamicAnswer: (source: "pricelist" | "colours") => Promise<string>;
  createBooking: (vars: Record<string, string>, action?: "service" | "demo" | "lead") => Promise<void>;
  handoff: (vars: Record<string, string>) => Promise<void>;
  // Real workshop availability (optional; provided by channel adapters)
  availableSlots?: () => Promise<{ id: string; label: string }[]>;
  bookSlot?: (slotId: string, vars: Record<string, string>) => Promise<{ ok: boolean; label?: string }>;
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

function interpolate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => vars[k] ?? "");
}

/** Encode/decode a choice id so an interactive reply tells us node + option. */
export const choiceId = (nodeId: string, optId: string) => `${nodeId}|${optId}`;

function matchChoice(node: Extract<FlowNode, { type: "choice" }>, input: FlowInput): string | null {
  // exact interactive reply id
  if (input.choiceId && input.choiceId.startsWith(`${node.id}|`)) {
    const optId = input.choiceId.slice(node.id.length + 1);
    return node.options.find((o) => o.id === optId)?.next ?? null;
  }
  // free-text fallbacks: number, label contains
  const t = input.text.trim().toLowerCase();
  const asNum = parseInt(t, 10);
  if (!Number.isNaN(asNum) && node.options[asNum - 1]) return node.options[asNum - 1].next ?? null;
  const hit = node.options.find((o) => t && o.label.toLowerCase().replace(/[^a-z0-9 ]/g, "").includes(t));
  return hit?.next ?? null;
}

/**
 * Advances the flow. If `session.nodeId` is set we're resuming from a waiting
 * node and `input` is the customer's reply; otherwise we start at `flow.start`.
 */
export async function runFlow(
  flow: Flow,
  session: FlowSession,
  input: FlowInput,
  ctx: FlowCtx
): Promise<FlowResult> {
  const messages: OutMsg[] = [];
  const vars = { ...session.vars };
  let nodeId: string | null;

  if (session.nodeId) {
    const cur = flow.nodes[session.nodeId];
    if (cur?.type === "choice") {
      nodeId = matchChoice(cur, input);
      if (!nodeId) {
        // didn't understand — re-send the same choice
        messages.push({ type: "choice", text: cur.text, options: cur.options.map((o) => ({ id: choiceId(cur.id, o.id), label: o.label, description: o.description })) });
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
      if (input.choiceId?.startsWith(`${cur.id}|`) && ctx.bookSlot) {
        const slotId = input.choiceId.slice(cur.id.length + 1);
        const res = await ctx.bookSlot(slotId, vars);
        if (!res.ok) {
          // slot filled — offer fresh ones
          const opts = ctx.availableSlots ? await ctx.availableSlots() : [];
          if (opts.length) {
            messages.push({ type: "choice", text: "That one just filled up — here are the next open times:", options: opts.map((o) => ({ id: choiceId(cur.id, o.id), label: o.label })) });
            return { messages, session: { nodeId: cur.id, vars }, handedOff: false };
          }
        } else if (res.label) {
          vars.slot = res.label;
        }
        nodeId = cur.next ?? null;
      } else {
        nodeId = cur.next ?? null;
      }
    } else if (cur?.type === "ai") {
      const ai = await ctx.aiReply(vars);
      messages.push({ type: "text", text: ai.reply });
      if (ai.handoff) {
        nodeId = cur.handoffNext ?? null;
        if (!nodeId) {
          await ctx.handoff(vars);
          return { messages, session: null, handedOff: true };
        }
      } else {
        return { messages, session: { nodeId: cur.id, vars }, handedOff: false };
      }
    } else {
      nodeId = flow.start;
    }
  } else {
    nodeId = flow.start;
  }

  let guard = 0;
  while (nodeId && guard++ < 50) {
    const node = flow.nodes[nodeId];
    if (!node) break;

    if (node.type === "message") {
      messages.push({ type: "text", text: interpolate(node.text, vars) });
      nodeId = node.next ?? null;
    } else if (node.type === "image") {
      messages.push({ type: "image", url: node.url, caption: node.caption ? interpolate(node.caption, vars) : undefined });
      nodeId = node.next ?? null;
    } else if (node.type === "captureFile") {
      messages.push({ type: "text", text: interpolate(node.text, vars) });
      return { messages, session: { nodeId: node.id, vars }, handedOff: false };
    } else if (node.type === "answer") {
      const text = node.answerSource ? await ctx.dynamicAnswer(node.answerSource) : interpolate(node.text ?? "", vars);
      if (text) messages.push({ type: "text", text });
      nodeId = node.next ?? null;
    } else if (node.type === "booking") {
      await ctx.createBooking(vars, node.action);
      if (node.text) messages.push({ type: "text", text: interpolate(node.text, vars) });
      nodeId = node.next ?? null;
    } else if (node.type === "slots") {
      const opts = ctx.availableSlots ? await ctx.availableSlots() : [];
      if (opts.length === 0) {
        messages.push({ type: "text", text: node.noneText || "We don't have open slots online right now — leave your details and the team will call you to book. 📞" });
        nodeId = node.next ?? null;
      } else {
        messages.push({ type: "choice", text: interpolate(node.text, vars), options: opts.map((o) => ({ id: choiceId(node.id, o.id), label: o.label })) });
        return { messages, session: { nodeId: node.id, vars }, handedOff: false };
      }
    } else if (node.type === "choice") {
      messages.push({ type: "choice", text: interpolate(node.text, vars), options: node.options.map((o) => ({ id: choiceId(node.id, o.id), label: o.label, description: o.description })) });
      return { messages, session: { nodeId: node.id, vars }, handedOff: false };
    } else if (node.type === "capture") {
      messages.push({ type: "text", text: interpolate(node.text, vars) });
      return { messages, session: { nodeId: node.id, vars }, handedOff: false };
    } else if (node.type === "ai") {
      const ai = await ctx.aiReply(vars);
      messages.push({ type: "text", text: ai.reply });
      if (ai.handoff) {
        nodeId = node.handoffNext ?? null;
        if (!nodeId) {
          await ctx.handoff(vars);
          return { messages, session: null, handedOff: true };
        }
      } else {
        return { messages, session: { nodeId: node.id, vars }, handedOff: false };
      }
    } else if (node.type === "handoff") {
      if (node.text) messages.push({ type: "text", text: interpolate(node.text, vars) });
      await ctx.handoff(vars);
      return { messages, session: null, handedOff: true };
    } else {
      // end
      return { messages, session: null, handedOff: false };
    }
  }
  return { messages, session: null, handedOff: false };
}

/** The out-of-the-box flow — used until a custom one is built in the editor. */
export const DEFAULT_FLOW: Flow = {
  start: "welcome",
  nodes: {
    welcome: {
      id: "welcome",
      type: "choice",
      text: "{{greeting}} How can we help today?",
      options: [
        { id: "prices", label: "💰 Prices", next: "showPrices" },
        { id: "book", label: "🔧 Book a service", next: "bookName" },
        { id: "chat", label: "💬 Chat to us", next: "aiChat" },
      ],
    },
    showPrices: { id: "showPrices", type: "answer", answerSource: "pricelist", next: "afterPrices" },
    afterPrices: {
      id: "afterPrices",
      type: "choice",
      text: "Anything else?",
      options: [
        { id: "chat", label: "💬 Ask a question", next: "aiChat" },
        { id: "menu", label: "🏠 Main menu", next: "welcome" },
        { id: "done", label: "👍 No thanks", next: "bye" },
      ],
    },
    bookName: { id: "bookName", type: "capture", text: "Sure — let's get you booked in. What's your name?", variable: "name", next: "bookPhone" },
    bookPhone: { id: "bookPhone", type: "capture", text: "Thanks {{name}}! What's the best contact number?", variable: "phone", format: "phone", next: "bookService" },
    bookService: { id: "bookService", type: "capture", text: "What does the cart need? (service, repair, etc.)", variable: "service", next: "chooseSlot" },
    chooseSlot: {
      id: "chooseSlot",
      type: "slots",
      text: "Here are our next available service times — pick one:",
      noneText: "We're fully booked online just now — I've logged your request and the team will call you to find a time. 📞",
      next: "bookConfirm",
    },
    bookConfirm: { id: "bookConfirm", type: "message", text: "You're booked, {{name}}! 🛠 {{slot}}. We'll see you then — message *menu* if anything changes.", next: "end" },
    aiChat: { id: "aiChat", type: "ai" },
    bye: { id: "bye", type: "message", text: "Cheers! Message *menu* any time to start again. 🛺", next: "end" },
    end: { id: "end", type: "end" },
  },
};

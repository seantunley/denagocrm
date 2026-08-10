import { DEFAULT_FLOW, type Flow } from "./flow";

export type FlowTemplateId = "general" | "sales" | "service" | "lead_capture" | "booking_management";
export type FlowTemplate = {
  id: FlowTemplateId;
  name: string;
  description: string;
  definition: Flow;
};

const SERVICE_FLOW: Flow = {
  start: "welcome",
  nodes: {
    welcome: { id: "welcome", type: "message", text: "{{greeting}} I can help you book your cart in for service.", next: "name" },
    name: { id: "name", type: "capture", text: "What's your name?", variable: "name", next: "phone" },
    phone: { id: "phone", type: "capture", text: "Thanks {{name}}. What's the best contact number?", variable: "phone", format: "phone", next: "service" },
    service: { id: "service", type: "capture", text: "What does the cart need help with?", variable: "service", next: "slot" },
    slot: { id: "slot", type: "slots", action: "book", text: "Choose one of the next available workshop times:", noneText: "There aren't open online slots just now — I'll log a service request so the team can call you.", next: "confirm", unavailableNext: "slotFallback", failureNext: "slotFallback" },
    slotFallback: { id: "slotFallback", type: "handoff", text: "I couldn't hold a time for you just now — one of the team will call you to book it." },
    confirm: { id: "confirm", type: "message", text: "You're booked, {{name}} — {{slot}}. We'll see you then. 🔧", next: "end" },
    end: { id: "end", type: "end" },
  },
};

const SALES_FLOW: Flow = {
  start: "welcome",
  nodes: {
    welcome: {
      id: "welcome",
      type: "choice",
      text: "{{greeting}} What can I help you with?",
      options: [
        { id: "prices", label: "💰 Prices", next: "prices" },
        { id: "demo", label: "🚗 Book a demo", next: "demoName" },
        { id: "question", label: "💬 Ask a question", next: "ai" },
      ],
    },
    prices: { id: "prices", type: "answer", answerSource: "pricelist", next: "afterPrices" },
    afterPrices: {
      id: "afterPrices",
      type: "choice",
      text: "What would you like to do next?",
      options: [
        { id: "demo", label: "Book a demo", next: "demoName" },
        { id: "question", label: "Ask a question", next: "ai" },
        { id: "done", label: "I'm done", next: "end" },
      ],
    },
    demoName: { id: "demoName", type: "capture", text: "Great — what's your name?", variable: "name", next: "demoPhone" },
    demoPhone: { id: "demoPhone", type: "capture", text: "What's the best contact number?", variable: "phone", format: "phone", next: "demoModel" },
    demoModel: { id: "demoModel", type: "capture", text: "Which Denago model are you interested in?", variable: "model", next: "createDemo" },
    createDemo: { id: "createDemo", type: "booking", action: "demo", text: "Thanks {{name}} — I've sent your demo request to the team. They'll confirm a time with you.", next: "end" },
    ai: { id: "ai", type: "ai" },
    end: { id: "end", type: "end" },
  },
};

const LEAD_CAPTURE_FLOW: Flow = {
  start: "welcome",
  nodes: {
    welcome: { id: "welcome", type: "message", text: "{{greeting}} Tell me a few details and I'll get the right person to help.", next: "name" },
    name: { id: "name", type: "capture", text: "What's your name?", variable: "name", next: "phone" },
    phone: { id: "phone", type: "capture", text: "What's the best contact number?", variable: "phone", format: "phone", next: "email" },
    email: { id: "email", type: "capture", text: "And your email address?", variable: "email", format: "email", next: "message" },
    message: { id: "message", type: "capture", text: "What can we help you with?", variable: "message", next: "create" },
    create: { id: "create", type: "booking", action: "lead", text: "Thanks {{name}} — your enquiry is with the team and we'll be in touch.", next: "end" },
    end: { id: "end", type: "end" },
  },
};

/**
 * Identity comes from the CHANNEL, never from a number typed into the chat.
 *
 * This flow used to open by asking "what's the contact number used for the
 * booking?" and treat the answer as identity. On Telegram that was the only
 * check there was, so anyone who knew a customer's number could read back their
 * next booking and then move or cancel it. The question is gone rather than
 * softened: asking for it at all implies it proves something.
 *
 * Where the channel cannot identify the sender the flow says so and hands over
 * to a person. Restoring self-service there needs proof of control of the number
 * (a one-time code), not a lookup.
 */
const BOOKING_MANAGEMENT_FLOW: Flow = {
  start: "intro",
  nodes: {
    intro: { id: "intro", type: "message", text: "{{greeting}} I can check, move or cancel an existing service booking.", next: "lookup" },
    lookup: { id: "lookup", type: "booking", action: "lookup", next: "identified", failureNext: "identified", unavailableNext: "identified" },
    identified: { id: "identified", type: "condition", condition: { variable: "booking_identity", operator: "equals", value: "verified" }, trueNext: "found", falseNext: "unverified" },
    unverified: { id: "unverified", type: "message", text: "For your security I can only manage a booking from the number or account it was made with. I'll get one of the team to help you from here.", next: "handoff" },
    found: { id: "found", type: "condition", condition: { variable: "booking_found", operator: "equals", value: "yes" }, trueNext: "show", falseNext: "notFound" },
    notFound: { id: "notFound", type: "message", text: "I couldn't find a future service booking on your customer record. I'll get the team to help.", next: "handoff" },
    show: {
      id: "show",
      type: "choice",
      text: "I found your next booking for {{booking_slot}}. What would you like to do?",
      options: [
        { id: "move", label: "Move booking", next: "newSlot" },
        { id: "cancel", label: "Cancel booking", next: "confirmCancel" },
        { id: "keep", label: "Keep it", next: "keep" },
      ],
    },
    confirmCancel: {
      id: "confirmCancel",
      type: "choice",
      text: "Cancel the service booking for {{booking_slot}}?",
      options: [
        { id: "yes", label: "Yes, cancel", next: "cancel" },
        { id: "no", label: "No, keep it", next: "keep" },
      ],
    },
    cancel: { id: "cancel", type: "booking", action: "cancel", text: "Done — your booking for {{booking_slot}} has been cancelled.", failureText: "I couldn't cancel that booking — it may already have changed. I'll get the team to confirm.", next: "end", failureNext: "handoff" },
    newSlot: { id: "newSlot", type: "slots", action: "reschedule", text: "Choose a new workshop time:", noneText: "There aren't any open online times right now — I'll get the team to help you move it.", next: "moved", unavailableNext: "handoff", failureNext: "handoff" },
    moved: { id: "moved", type: "message", text: "Done — your service booking is now {{booking_slot}}. 🔧", next: "end" },
    keep: { id: "keep", type: "message", text: "No problem — your booking stays at {{booking_slot}}.", next: "end" },
    handoff: { id: "handoff", type: "handoff", text: "One of the team will pick this up from here." },
    end: { id: "end", type: "end" },
  },
};

export const FLOW_TEMPLATES: FlowTemplate[] = [
  {
    id: "general",
    name: "General assistant",
    description: "Prices, service booking and an AI question path. Best all-round starting point.",
    definition: DEFAULT_FLOW,
  },
  {
    id: "sales",
    name: "Sales & demo",
    description: "Show live pricing, capture demo interest and hand open product questions to the assistant.",
    definition: SALES_FLOW,
  },
  {
    id: "service",
    name: "Service booking",
    description: "Capture customer/service details and offer real workshop availability.",
    definition: SERVICE_FLOW,
  },
  {
    id: "booking_management",
    name: "Manage service booking",
    description: "Find an existing customer booking, then keep, cancel or atomically move it to another real workshop slot.",
    definition: BOOKING_MANAGEMENT_FLOW,
  },
  {
    id: "lead_capture",
    name: "Lead capture",
    description: "A short qualification path that creates a CRM enquiry from captured details.",
    definition: LEAD_CAPTURE_FLOW,
  },
];

export function flowTemplate(id: string | null | undefined): FlowTemplate {
  return FLOW_TEMPLATES.find((template) => template.id === id) ?? FLOW_TEMPLATES[0];
}

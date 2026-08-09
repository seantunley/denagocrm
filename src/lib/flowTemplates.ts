import { DEFAULT_FLOW, type Flow } from "./flow";

export type FlowTemplateId = "general" | "sales" | "service" | "lead_capture";
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
    slot: { id: "slot", type: "slots", text: "Choose one of the next available workshop times:", noneText: "There aren't open online slots just now — I'll log a service request so the team can call you.", next: "confirm" },
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
    id: "lead_capture",
    name: "Lead capture",
    description: "A short qualification path that creates a CRM enquiry from captured details.",
    definition: LEAD_CAPTURE_FLOW,
  },
];

export function flowTemplate(id: string | null | undefined): FlowTemplate {
  return FLOW_TEMPLATES.find((template) => template.id === id) ?? FLOW_TEMPLATES[0];
}

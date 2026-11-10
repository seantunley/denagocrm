import { DEFAULT_FLOW, type Flow, type FlowNode } from "./flow";

export type FlowTemplateId =
  | "blank" | "general" | "sales" | "service" | "lead_capture" | "booking_management" | "qr_brochure"
  | "front_desk" | "smart_enquiry" | "feedback";
export type FlowTemplate = {
  id: FlowTemplateId;
  name: string;
  description: string;
  definition: Flow;
};

/*
 * HOW THE STARTERS TALK (2026-11-10). Every starter is somebody's first conversation with a business, so each is
 * written the way a person at the front desk would handle it:
 *
 * - ONE THING AT A TIME, in short messages, and each answer is acknowledged before the next question.
 * - NEVER ASK WHAT WE KNOW. {{known}} is set when the channel already matched a customer, so they are not asked who
 *   they are — and where the action reuses their record (bookings, demos) not for a number either. An enquiry
 *   ("lead") is created from the typed details alone, so those flows always ask for a number.
 * - A TYPED QUESTION GETS AN ANSWER. Menus carry `elseNext` to the assistant step wherever there is one.
 * - READ IT BACK before anything is sent to the team, with a way to fix it.
 * - SAY WHAT HAPPENS NEXT, truthfully: by opening hours where the wait depends on them, and never "done" for an
 *   action that failed (every fallible step has its own failure route; `onFailure` catches anything else).
 * - NEVER MESSAGES FIRST: no starter has an "if no reply" route or anything else that sends without the customer
 *   having just written. Automatic sends stay off until the owner turns them on in the builder (Sean, 2026-11-10).
 * - HAND-OFFS CARRY A REASON (and what was captured), so staff do not have to scroll the chat to see why.
 */

/** "Talk to a person", said truthfully by whether anyone is there: an Opening hours step and its two hand-offs. */
function humanSteps(reason: string): Record<string, FlowNode> {
  return {
    human: { id: "human", type: "hours", openNext: "humanOpen", closedNext: "humanClosed" },
    humanOpen: { id: "humanOpen", type: "handoff", text: "No problem — I'm getting one of the team for you now. They'll reply right here. 🙌", reason },
    humanClosed: { id: "humanClosed", type: "handoff", text: "We're closed at the moment, so I've left a note for the team — they'll reply right here as soon as we're back.", reason: `${reason} (after hours)` },
  };
}

/** The flow-wide "If anything fails" step every starter with an action shares. */
const TEAM_HELP: FlowNode = { id: "teamHelp", type: "handoff", text: "Sorry — something went wrong on my side. I'm getting one of the team to help you from here.", reason: "A step in the flow failed" };

const SERVICE_FLOW: Flow = {
  start: "welcome",
  onFailure: "teamHelp",
  nodes: {
    welcome: { id: "welcome", type: "message", text: "{{greeting}} Let's get you booked in — it only takes a minute.", next: "who" },
    who: { id: "who", type: "condition", condition: { variable: "known", operator: "exists" }, trueNext: "service", falseNext: "name" },
    name: { id: "name", type: "capture", text: "First, who am I chatting to?", variable: "name", next: "phone" },
    phone: { id: "phone", type: "capture", text: "Thanks, {{name}}! And the best number to reach you on?", variable: "phone", format: "phone", next: "service" },
    service: { id: "service", type: "capture", text: "What would you like us to look at? A line or two is plenty.", variable: "service", next: "slot" },
    slot: { id: "slot", type: "slots", action: "book", text: "Got it. Here's what the workshop has open — which one suits you?", noneText: "The workshop is fully booked online at the moment, so I've passed your details to the team — someone will call you to find a time. 📞", failureText: "Sorry, I couldn't hold that time for you — I'm getting the team to book it with you directly.", next: "confirm", unavailableNext: "slotsFull", failureNext: "slotFallback" },
    slotsFull: { id: "slotsFull", type: "handoff", reason: "Service booking: no open slots online", summary: "{{name}} needs: {{service}}" },
    slotFallback: { id: "slotFallback", type: "handoff", reason: "Service booking: the chosen time could not be held", summary: "{{name}} needs: {{service}}" },
    confirm: { id: "confirm", type: "message", text: "All set, {{name}} — you're booked for {{slot}}. 🔧", next: "after" },
    after: { id: "after", type: "message", text: "If anything changes before then, just message us here. See you soon!", next: "end" },
    teamHelp: TEAM_HELP,
    end: { id: "end", type: "end" },
  },
};

const SALES_FLOW: Flow = {
  start: "welcome",
  onFailure: "teamHelp",
  nodes: {
    welcome: {
      id: "welcome",
      type: "choice",
      text: "{{greeting}} Looking for something in particular? Tap an option, or just ask me anything.",
      elseNext: "ai",
      options: [
        { id: "prices", label: "💰 See prices", next: "prices" },
        { id: "demo", label: "📅 Book a demo", next: "demoWho" },
        { id: "human", label: "🙋 Talk to sales", next: "human" },
      ],
    },
    prices: { id: "prices", type: "answer", answerSource: "pricelist", next: "afterPrices" },
    afterPrices: {
      id: "afterPrices",
      type: "choice",
      text: "Want to see one in person, or is there something you'd like to know more about? Just ask.",
      elseNext: "ai",
      options: [
        { id: "demo", label: "📅 Book a demo", next: "demoWho" },
        { id: "question", label: "💬 Ask a question", next: "ai" },
        { id: "done", label: "👀 Just browsing", next: "browsing" },
      ],
    },
    browsing: { id: "browsing", type: "message", text: "No pressure at all — take your time. I'm right here if anything comes up. 👋", next: "end" },
    demoWho: { id: "demoWho", type: "condition", condition: { variable: "known", operator: "exists" }, trueNext: "demoKnown", falseNext: "demoName" },
    demoKnown: { id: "demoKnown", type: "message", text: "Great, {{name}} — let's set that up.", next: "demoModel" },
    demoName: { id: "demoName", type: "capture", text: "Great — let's set that up. Who am I chatting to?", variable: "name", next: "demoPhone" },
    demoPhone: { id: "demoPhone", type: "capture", text: "Nice to meet you, {{name}}! What's the best number for the team to reach you on?", variable: "phone", format: "phone", next: "demoModel" },
    demoModel: { id: "demoModel", type: "capture", text: "Which product would you like to see? If you're not sure yet, just say so.", variable: "model", next: "demoWhen" },
    demoWhen: { id: "demoWhen", type: "capture", text: "Good choice. And when would suit you — this week, a Saturday morning, whenever you like?", variable: "date", next: "createDemo" },
    createDemo: { id: "createDemo", type: "booking", action: "demo", text: "Lovely — that's with the team now, {{name}}. Someone will be in touch to confirm a time.", failureText: "Sorry {{name}}, I couldn't log that on my side — I'm getting one of the team to set it up with you directly.", next: "demoDone", failureNext: "demoHandoff" },
    demoHandoff: { id: "demoHandoff", type: "handoff", reason: "Demo request could not be logged", summary: "{{name}} wants a demo of {{model}} ({{date}})." },
    demoDone: {
      id: "demoDone",
      type: "choice",
      text: "Anything else I can help with while you're here?",
      elseNext: "ai",
      options: [
        { id: "question", label: "💬 Ask a question", next: "ai" },
        { id: "done", label: "👍 That's all", next: "bye" },
      ],
    },
    ...humanSteps("Asked to talk to sales"),
    ai: { id: "ai", type: "ai" },
    bye: { id: "bye", type: "message", text: "Great — chat soon! 👋", next: "end" },
    teamHelp: TEAM_HELP,
    end: { id: "end", type: "end" },
  },
};

/**
 * What they need first, then how to reach them — the order a person would ask in — and the details are read back
 * before the enquiry is created. The enquiry is made from the typed details alone, so a number is always asked for.
 */
const LEAD_CAPTURE_FLOW: Flow = {
  start: "welcome",
  onFailure: "teamHelp",
  nodes: {
    welcome: { id: "welcome", type: "message", text: "{{greeting}} Happy to help — I'll get the right person onto it.", next: "message" },
    message: { id: "message", type: "capture", text: "What can we help you with? A sentence or two is perfect.", variable: "message", next: "who" },
    who: { id: "who", type: "condition", condition: { variable: "known", operator: "exists" }, trueNext: "phone", falseNext: "name" },
    name: { id: "name", type: "capture", text: "Got it. And who am I chatting to?", variable: "name", next: "phone" },
    phone: { id: "phone", type: "capture", text: "Thanks, {{name}}! What's the best number for the team to reach you on?", variable: "phone", format: "phone", next: "emailAsk" },
    emailAsk: {
      id: "emailAsk",
      type: "choice",
      text: "Would you like us to email you as well?",
      options: [
        { id: "yes", label: "📧 Yes, email me", next: "email" },
        { id: "no", label: "No, phone is fine", next: "check" },
      ],
    },
    email: { id: "email", type: "capture", text: "Sure — what's the best email address?", variable: "email", format: "email", next: "check" },
    check: {
      id: "check",
      type: "choice",
      text: "Just to make sure I've got it right:\n\n👤 {{name}}\n📞 {{phone}}\n📝 {{message}}\n\nShall I send this to the team?",
      options: [
        { id: "yes", label: "✅ Yes, send it", next: "create" },
        { id: "fix", label: "✏️ Change something", next: "redo" },
      ],
    },
    redo: { id: "redo", type: "message", text: "No problem — let's go through it again.", next: "message" },
    create: { id: "create", type: "booking", action: "lead", text: "Done — that's with the team now, {{name}}.", failureText: "Sorry {{name}}, I couldn't send that through — I'm getting one of the team to pick it up so it doesn't get lost.", next: "when", failureNext: "createFailed" },
    createFailed: { id: "createFailed", type: "handoff", reason: "Enquiry could not be created", summary: "{{name}} ({{phone}}): {{message}}" },
    when: { id: "when", type: "hours", openNext: "soon", closedNext: "nextDay" },
    soon: { id: "soon", type: "message", text: "Someone will be in touch with you shortly. 👍", next: "end" },
    nextDay: { id: "nextDay", type: "message", text: "We're closed right now, so you'll hear from us as soon as we're back.", next: "end" },
    teamHelp: TEAM_HELP,
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
 *
 * No "anything else" route to an assistant here, on purpose: every way out of the
 * unverified branch must stay a hand-off to a person (tests/botBookingManagementFlow).
 */
const BOOKING_MANAGEMENT_FLOW: Flow = {
  start: "intro",
  nodes: {
    intro: { id: "intro", type: "message", text: "{{greeting}} Let me pull up your booking — one moment.", next: "lookup" },
    lookup: { id: "lookup", type: "booking", action: "lookup", next: "identified", failureNext: "identified", unavailableNext: "identified" },
    identified: { id: "identified", type: "condition", condition: { variable: "booking_identity", operator: "equals", value: "verified" }, trueNext: "found", falseNext: "unverified" },
    unverified: { id: "unverified", type: "message", text: "For your security I can only change a booking from the number or account it was made with — so I'm getting one of the team to help you with this one.", next: "handoffUnverified" },
    handoffUnverified: { id: "handoffUnverified", type: "handoff", reason: "Booking change: could not verify the customer on this channel" },
    found: { id: "found", type: "condition", condition: { variable: "booking_found", operator: "equals", value: "yes" }, trueNext: "show", falseNext: "notFound" },
    notFound: { id: "notFound", type: "message", text: "I couldn't find an upcoming booking under your details, so I'm getting someone from the team to check for you.", next: "handoffNotFound" },
    handoffNotFound: { id: "handoffNotFound", type: "handoff", reason: "Booking change: no upcoming booking found" },
    show: {
      id: "show",
      type: "choice",
      text: "Found it — you're booked for {{booking_slot}}. What would you like to do?",
      options: [
        { id: "move", label: "📅 Move it", next: "newSlot" },
        { id: "cancel", label: "❌ Cancel it", next: "confirmCancel" },
        { id: "keep", label: "👍 Keep it", next: "keep" },
      ],
    },
    confirmCancel: {
      id: "confirmCancel",
      type: "choice",
      text: "Just checking — cancel your booking for {{booking_slot}}?",
      options: [
        { id: "yes", label: "Yes, cancel it", next: "cancel" },
        { id: "no", label: "No, keep it", next: "keep" },
      ],
    },
    cancel: { id: "cancel", type: "booking", action: "cancel", text: "Done — your booking for {{booking_slot}} is cancelled. Thanks for letting us know, and message us here whenever you'd like a new time.", failureText: "I couldn't cancel that one — it may have changed since I looked. I'm getting the team to confirm it with you.", next: "end", failureNext: "handoffFailed" },
    newSlot: { id: "newSlot", type: "slots", action: "reschedule", text: "No problem — here's what's open. Which one works better?", noneText: "There's nothing open online right now, so I'm getting the team to help you move it.", failureText: "I couldn't move it to that time — I'm getting the team to sort it out with you.", next: "moved", unavailableNext: "handoffNoSlots", failureNext: "handoffFailed" },
    handoffNoSlots: { id: "handoffNoSlots", type: "handoff", reason: "Booking move: no open slots online", summary: "Currently booked for {{booking_slot}}." },
    handoffFailed: { id: "handoffFailed", type: "handoff", reason: "Booking change could not be completed", summary: "Booking shown to the customer: {{booking_slot}}." },
    moved: { id: "moved", type: "message", text: "Done — you're now booked for {{booking_slot}}. See you then! 🔧", next: "end" },
    keep: { id: "keep", type: "message", text: "No problem — your booking stays as it is, {{booking_slot}}. See you then!", next: "end" },
    end: { id: "end", type: "end" },
  },
};

/** "New flow" starts here (Sean, 2026-11-02: "why does a new flow start with all those nodes and not blank?"). */
const BLANK_FLOW: Flow = {
  start: "welcome",
  nodes: {
    welcome: { id: "welcome", type: "message", text: "{{greeting}}", next: "end" },
    end: { id: "end", type: "end" },
  },
};

/**
 * For a QR code on a poster or flyer (Chatbot → Routes → QR codes): the customer scans, taps Send, and gets the
 * brochure, the price list and the business's contact card at once, then is asked whether someone should contact
 * them. The two files are left for the owner to choose — publishing is blocked until they are.
 */
const QR_BROCHURE_FLOW: Flow = {
  start: "welcome",
  nodes: {
    welcome: { id: "welcome", type: "message", text: "{{greeting}} Thanks for scanning! Here's our brochure and price list to look through.", next: "brochure" },
    brochure: { id: "brochure", type: "document", documentId: "", caption: "Our brochure", next: "pricelist" },
    pricelist: { id: "pricelist", type: "document", documentId: "", caption: "Our price list", next: "card" },
    card: { id: "card", type: "contactCard", next: "followUp" },
    followUp: {
      id: "followUp",
      type: "choice",
      text: "Take your time with those. Would you like someone from the team to get in touch?",
      options: [
        { id: "yes", label: "📞 Yes, please", next: "when" },
        { id: "no", label: "👍 No, thanks", next: "bye" },
      ],
    },
    when: { id: "when", type: "hours", openNext: "handoff", closedNext: "handoffClosed" },
    handoff: { id: "handoff", type: "handoff", text: "Great — someone will be in touch with you shortly.", reason: "QR code: asked to be contacted" },
    handoffClosed: { id: "handoffClosed", type: "handoff", text: "Great — we're closed right now, so you'll hear from us as soon as we're back.", reason: "QR code: asked to be contacted (after hours)" },
    bye: { id: "bye", type: "message", text: "No problem at all — if a question comes up, just message us here. 👋", next: "end" },
    end: { id: "end", type: "end" },
  },
};

/**
 * THE FRONT DESK: one flow for the whole day. Open, it offers a question, a call back or a person. Closed, it says so
 * up front — and still answers questions or takes a message — instead of letting someone wait on a reply that will
 * not come until morning.
 */
const FRONT_DESK_FLOW: Flow = {
  start: "hours",
  onFailure: "teamHelp",
  nodes: {
    hours: { id: "hours", type: "hours", openNext: "welcome", closedNext: "closed" },
    welcome: {
      id: "welcome",
      type: "choice",
      text: "{{greeting}} How can I help? Tap an option, or just type your question.",
      elseNext: "ai",
      options: [
        { id: "ask", label: "💬 Ask a question", next: "ai" },
        { id: "call", label: "📞 Call me back", next: "who" },
        { id: "human", label: "🙋 Talk to someone", next: "humanOpen" },
      ],
    },
    closed: {
      id: "closed",
      type: "choice",
      text: "{{greeting}} We're closed right now, but I'm still here. I can answer most questions straight away, or take a message so the team gets back to you as soon as we open.",
      elseNext: "ai",
      options: [
        { id: "ask", label: "💬 Ask me now", next: "ai" },
        { id: "msg", label: "📝 Leave a message", next: "who" },
      ],
    },
    humanOpen: { id: "humanOpen", type: "handoff", text: "No problem — I'm getting one of the team for you now. They'll reply right here. 🙌", reason: "Asked to talk to a person" },
    who: { id: "who", type: "condition", condition: { variable: "known", operator: "exists" }, trueNext: "phone", falseNext: "name" },
    name: { id: "name", type: "capture", text: "Of course. Who am I chatting to?", variable: "name", next: "phone" },
    phone: { id: "phone", type: "capture", text: "Thanks, {{name}}! What's the best number to reach you on?", variable: "phone", format: "phone", next: "message" },
    message: { id: "message", type: "capture", text: "And what should I tell the team it's about?", variable: "message", next: "create" },
    create: { id: "create", type: "booking", action: "lead", text: "Got it, {{name}} — I've passed that on.", failureText: "Sorry {{name}}, I couldn't save that — I'm getting one of the team to pick it up so it doesn't get lost.", next: "when", failureNext: "createFailed" },
    createFailed: { id: "createFailed", type: "handoff", reason: "Message could not be saved", summary: "{{name}} ({{phone}}): {{message}}" },
    when: { id: "when", type: "hours", openNext: "soon", closedNext: "nextDay" },
    soon: { id: "soon", type: "message", text: "Someone will give you a call shortly. 📞", next: "end" },
    nextDay: { id: "nextDay", type: "message", text: "It'll be the first thing the team sees when we open. Chat soon! 👋", next: "end" },
    ai: { id: "ai", type: "ai" },
    teamHelp: TEAM_HELP,
    end: { id: "end", type: "end" },
  },
};

/**
 * THE ENQUIRY A PERSON WOULD TAKE: one open question, and the assistant reads the name, number and need out of the
 * reply — then asks only for what is still missing, reads it back and sends it to the team.
 *
 * Needs the AI switched on. Without it (or when it reads nothing) the same flow simply asks for the name and number
 * one at a time, so nobody is ever stuck. The enquiry carries {{message}}, the customer's own words exactly as they
 * approved them at the read-back — never an AI summary, which could describe an earlier version after a fix.
 */
const SMART_ENQUIRY_FLOW: Flow = {
  start: "hello",
  onFailure: "teamHelp",
  nodes: {
    hello: { id: "hello", type: "message", text: "{{greeting}} Happy to help.", next: "details" },
    details: { id: "details", type: "capture", text: "Tell me what you're looking for, in your own words. If you add your name and the best number to reach you, I won't need to ask twice. 🙂", variable: "details", next: "keepWords" },
    keepWords: { id: "keepWords", type: "set", variable: "message", value: "{{details}}", next: "read" },
    read: { id: "read", type: "extract", sourceVariable: "details", instruction: "A customer is making an enquiry. name = the customer's own name. phone = the customer's contact number. email = the customer's email address.", fields: ["name", "phone", "email"], next: "hasName", failureNext: "hasName" },
    hasName: { id: "hasName", type: "condition", condition: { variable: "name", operator: "exists" }, trueNext: "hasPhone", falseNext: "askName" },
    askName: { id: "askName", type: "capture", text: "Thanks for that! Who am I chatting to?", variable: "name", next: "hasPhone" },
    hasPhone: { id: "hasPhone", type: "condition", condition: { variable: "phone", operator: "exists" }, trueNext: "check", falseNext: "askPhone" },
    askPhone: { id: "askPhone", type: "capture", text: "Thanks, {{name}}. What's the best number for the team to reach you on?", variable: "phone", format: "phone", next: "check" },
    check: {
      id: "check",
      type: "choice",
      text: "Here's what I've got:\n\n👤 {{name}}\n📞 {{phone}}\n📝 {{message}}\n\nDid I get that right?",
      options: [
        { id: "yes", label: "✅ Yes, send it", next: "create" },
        { id: "fix", label: "✏️ Not quite", next: "fix" },
      ],
    },
    // Each fix re-asks one thing and comes straight back to the read-back; the rest is kept.
    fix: {
      id: "fix",
      type: "choice",
      text: "No problem — which part should I fix?",
      options: [
        { id: "name", label: "👤 My name", next: "askName" },
        { id: "phone", label: "📞 My number", next: "askPhone" },
        { id: "message", label: "📝 My message", next: "details" },
      ],
    },
    create: { id: "create", type: "booking", action: "lead", text: "Done — that's with the team now, {{name}}.", failureText: "Sorry {{name}}, I couldn't send that through — I'm getting one of the team to pick it up so it doesn't get lost.", next: "when", failureNext: "createFailed" },
    createFailed: { id: "createFailed", type: "handoff", reason: "Enquiry could not be created", summary: "{{name}} ({{phone}}): {{message}}" },
    when: { id: "when", type: "hours", openNext: "soon", closedNext: "nextDay" },
    soon: { id: "soon", type: "message", text: "Someone will be in touch with you shortly. 👍", next: "end" },
    nextDay: { id: "nextDay", type: "message", text: "We're closed right now, so you'll hear from us as soon as we're back.", next: "end" },
    teamHelp: TEAM_HELP,
    end: { id: "end", type: "end" },
  },
};

/**
 * "HOW DID WE DO?" — for a QR code at the counter or a keyword route. A happy customer is thanked and tagged, not
 * questioned. Anyone else is asked what happened, and it goes to a person with their words as the summary: an
 * unhappy customer should hear back from someone, not from the bot.
 *
 * The tags need a customer record; where the channel has not matched one the step is skipped quietly (its failure
 * route is its ordinary one).
 */
const FEEDBACK_FLOW: Flow = {
  start: "ask",
  nodes: {
    ask: {
      id: "ask",
      type: "choice",
      text: "{{greeting}} Quick one — how was your experience with us?",
      elseNext: "typed",
      options: [
        { id: "great", label: "😀 Great", next: "tagHappy" },
        { id: "ok", label: "🙂 It was okay", next: "okWhat" },
        { id: "bad", label: "🙁 Not great", next: "badSorry" },
      ],
    },
    typed: { id: "typed", type: "handoff", text: "Thank you for telling us — I've passed your message straight to the team.", reason: "Feedback: written in the customer's own words" },
    tagHappy: { id: "tagHappy", type: "crm", action: "tag", tagName: "Feedback: happy", next: "great", failureNext: "great" },
    great: { id: "great", type: "message", text: "That's wonderful to hear — thank you! It means a lot to the team. 🙌", next: "end" },
    okWhat: { id: "okWhat", type: "capture", text: "Thanks for being honest. What's one thing we could have done better?", variable: "feedback", next: "okThanks" },
    okThanks: { id: "okThanks", type: "handoff", text: "Thank you — that really helps. I've passed it on to the team.", reason: "Feedback: could be better", summary: "{{feedback}}" },
    badSorry: { id: "badSorry", type: "message", text: "I'm really sorry to hear that — that's not the experience we want you to have.", next: "badWhat" },
    badWhat: { id: "badWhat", type: "capture", text: "Would you tell me what happened? I'll make sure the right person sees it.", variable: "complaint", next: "tagUnhappy" },
    tagUnhappy: { id: "tagUnhappy", type: "crm", action: "tag", tagName: "Feedback: unhappy", next: "badCall", failureNext: "badCall" },
    badCall: {
      id: "badCall",
      type: "choice",
      text: "Thank you for telling me. Would you like someone to call you about it?",
      options: [
        { id: "yes", label: "📞 Yes, call me", next: "badCallYes" },
        { id: "no", label: "No, just pass it on", next: "badPass" },
      ],
    },
    badCallYes: { id: "badCallYes", type: "handoff", text: "Done — I've flagged it for the team and someone will call you.", reason: "Unhappy customer — wants a call", summary: "{{complaint}}" },
    badPass: { id: "badPass", type: "handoff", text: "Understood — I've passed it on. Thank you for giving us the chance to put it right.", reason: "Unhappy customer — feedback only", summary: "{{complaint}}" },
    end: { id: "end", type: "end" },
  },
};

export const FLOW_TEMPLATES: FlowTemplate[] = [
  {
    id: "blank",
    name: "Blank",
    description: "A greeting and nothing else — build your own from there.",
    definition: BLANK_FLOW,
  },
  {
    id: "qr_brochure",
    name: "QR code: brochure pack",
    description: "For a QR code on a poster or flyer: sends your brochure, price list and contact card, then offers a call back. Choose the two files, publish, then make the QR code under Routing.",
    definition: QR_BROCHURE_FLOW,
  },
  {
    id: "general",
    name: "General assistant",
    description: "Prices, service booking, a person on request, and typed questions answered by the assistant. Best all-round starting point.",
    definition: DEFAULT_FLOW,
  },
  {
    id: "front_desk",
    name: "Front desk (open & closed)",
    description: "One flow for the whole day: questions, a call back or a person while you're open; an honest “we're closed” with answers and message-taking when you're not.",
    definition: FRONT_DESK_FLOW,
  },
  {
    id: "sales",
    name: "Sales & demo",
    description: "Show live pricing, book a demo without re-asking customers you already know, and answer typed product questions with the assistant.",
    definition: SALES_FLOW,
  },
  {
    id: "service",
    name: "Service booking",
    description: "Take the job details, skip what you already know, and offer real workshop availability — or pass it to the team when nothing is open.",
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
    description: "Asks what they need first, then how to reach them, reads it back and creates a CRM enquiry.",
    definition: LEAD_CAPTURE_FLOW,
  },
  {
    id: "smart_enquiry",
    name: "Smart enquiry (AI)",
    description: "One open question: the assistant reads the name, number and need out of the reply and only asks for what's missing. Falls back to step-by-step questions without AI.",
    definition: SMART_ENQUIRY_FLOW,
  },
  {
    id: "feedback",
    name: "Feedback check-in",
    description: "“How did we do?” — thanks and tags happy customers; asks unhappy ones what happened and hands them to a person with their words attached.",
    definition: FEEDBACK_FLOW,
  },
];

export function flowTemplate(id: string | null | undefined): FlowTemplate {
  return FLOW_TEMPLATES.find((template) => template.id === id) ?? FLOW_TEMPLATES.find((template) => template.id === "general")!;
}

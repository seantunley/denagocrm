import { z } from "zod";
import { scheduleFields, type Cadence } from "./assistantSchedule";
import { watchFields, type WatchInput } from "./assistantWatchRules";

/**
 * Tasks the assistant can PROPOSE — never perform. It drafts; the person sees a
 * card and presses Confirm (or Send), and only then does the matching existing
 * server action run (scheduleFollowUp, scheduleActivity, createTestDriveBooking,
 * rescheduleActivity, cancelActivity, addCommunication, assignLead, moveLead,
 * markLost, createQuoteFromLead, openJobCard, and the lead page's own message box), with
 * that person's own permissions, the stage gates, the clash checks and the
 * audit log, exactly as if they had done it by hand. A scheduled question is
 * saved for the signed-in person only, and later runs as them.
 *
 * A message to a customer goes out only when the person presses Send on its
 * card, after reading (and if they like, editing) it. The assistant never sends
 * anything on its own (definition of done: no send without an explicit click).
 */

const leadId = z.string().trim().min(10).max(40);
const activityId = z.string().trim().min(10).max(40);
const text = z.string().trim().min(1);
const at = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/);
const atTime = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
const minutes = z.number().int().min(15).max(480);
const reason = z.string().trim().min(3).max(160).optional();
/** The most lines the assistant may put on a quote it builds. A longer quote is built in the editor. */
export const QUOTE_BUILD_MAX_LINES = 10;
/** Fees the assistant may add to a draft in one go, and the most one may be (rands). More than that is the editor's. */
export const QUOTE_ADD_MAX_FEES = 5;
export const QUOTE_ADD_MAX_FEE_RANDS = 1_000_000;

export const proposedAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("follow_up"),
    leadId,
    when: at,
    activity: z.enum(["call", "whatsapp", "email", "meeting", "todo"]).default("call"),
    summary: text.max(120).optional(),
    reason,
  }).strict(),
  // pin: keeps the note at the top of the timeline — only when the person asks for it pinned.
  z.object({ type: z.literal("note"), leadId, text: text.max(2000), pin: z.boolean().optional(), reason }).strict(),
  // A note on a CUSTOMER rather than a deal — the only place a note can go for
  // someone who has no lead.
  z.object({ type: z.literal("customer_note"), contactId: leadId, text: text.max(2000), pin: z.boolean().optional(), reason }).strict(),
  z.object({ type: z.literal("assign"), leadId, to: text.max(80), reason }).strict(),
  z.object({ type: z.literal("stage"), leadId, stage: text.max(80), reason }).strict(),
  z.object({
    type: z.literal("draft_message"),
    leadId,
    channel: z.enum(["whatsapp", "email"]),
    subject: text.max(150).optional(),
    body: text.max(2000),
    reason,
  }).strict(),
  // A meeting at a set time, with colleagues — through the calendar's own
  // booking, so a clash with anyone's diary is refused there.
  z.object({
    type: z.literal("meeting"),
    leadId,
    when: atTime,
    minutes: minutes.optional(),
    with: z.array(text.max(80)).max(5).optional(),
    summary: text.max(120).optional(),
    reason,
  }).strict(),
  z.object({ type: z.literal("test_drive"), leadId, when: atTime, minutes: minutes.optional(), vehicle: text.max(80), reason }).strict(),
  // A workshop job card on a CUSTOMER'S OWN vehicle (Automotive) — opened at Confirm by the job-card form's own
  // action (openJobCard). The vehicle by its id from the vehicles lookup: never guessed between several.
  z.object({
    type: z.literal("job_card"),
    vehicleId: leadId,
    description: text.max(500),
    priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
    kmIn: z.number().int().min(0).max(1_000_000).optional(),
    reason,
  }).strict(),
  // A personal calendar item: time blocked on the person's OWN calendar, tied to
  // no lead or customer. `when` with a time blocks `minutes` from then (an hour
  // if not given); a date alone blocks the whole day, through `until` if given.
  // The calendar asks why the time is unavailable, so `note` is required.
  z.object({
    type: z.literal("block_time"),
    when: at,
    minutes: z.number().int().min(15).max(720).optional(),
    until: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    summary: text.max(120).optional(),
    note: text.max(300),
    reason,
  }).strict(),
  z.object({ type: z.literal("reschedule"), activityId, when: at, reason }).strict(),
  z.object({ type: z.literal("cancel_activity"), activityId, reason }).strict(),
  z.object({ type: z.literal("lost"), leadId, reason: text.max(300) }).strict(),
  z.object({ type: z.literal("quote"), leadId, reason }).strict(),
  // A draft quote WITH its lines. Catalogue products only: the price is the
  // catalogue's, read again when the card is built and again when it is
  // confirmed — never a figure the model supplied.
  //
  // FOR A CUSTOMER — with a deal, or without one. An existing customer who wants
  // another quote is existing business, not a new lead (Sean, 2026-10-12): the
  // CRM has always let a quote be made for a customer directly, and the first
  // version of this task wrongly insisted on a lead. `leadId` when the quote is
  // for a deal; otherwise `contactId`. (Both optional here because a
  // discriminated union cannot carry an either/or rule — the card builder
  // refuses a task that names neither.)
  //
  // A product is named by its catalogue id, or by its NAME exactly as the
  // catalogue lists it — resolved against the catalogue when the card is built,
  // so a name that is not one product there proposes nothing.
  z.object({
    type: z.literal("quote_build"),
    leadId: leadId.optional(),
    contactId: z.string().trim().min(10).max(40).optional(),
    lines: z.array(
      z.object({
        productId: z.string().trim().min(10).max(40).optional(),
        product: text.max(120).optional(),
        qty: z.number().int().min(1).max(500),
        discountPct: z.number().min(0).max(100).optional(),
        colour: text.max(60).optional(),
      }).strict(),
    // Left out for a quote on a job sheet: the CRM fills the lines from the sheet (assistantTaskRules).
    ).min(1).max(QUOTE_BUILD_MAX_LINES).optional(),
    // A fee said with the request ("delivery to Hermanus, R6 500") goes on the SAME draft — one Confirm, not a
    // second quote_add that needs the number of a quote not created yet (Sean, 2026-10-24). The amount is the
    // person's, as on quote_add; the card shows it before anything is saved.
    fees: z.array(
      z.object({ label: text.max(120), amount: z.number().positive().max(QUOTE_ADD_MAX_FEE_RANDS), delivery: z.boolean().optional() }).strict(),
    ).max(QUOTE_ADD_MAX_FEES).optional(),
    reason,
  }).strict(),
  // ADD to a quote that is still a DRAFT (Sean, 2026-10-12: "Please add R5000
  // Delivery Fee to the quote" was refused). `quote` is its number ("Q-1030").
  // A fee carries the amount the PERSON said, in rands — there is no catalogue
  // to take it from — and the card shows it before anything is saved. A product
  // line is the same as on quote_build: catalogue product, catalogue price.
  // It only adds: nothing already on the quote is changed or removed.
  z.object({
    type: z.literal("quote_add"),
    // Left out on a job sheet that has its quote: the CRM uses the sheet's.
    quote: text.max(40).optional(),
    fees: z.array(
      z.object({ label: text.max(120), amount: z.number().positive().max(QUOTE_ADD_MAX_FEE_RANDS), delivery: z.boolean().optional() }).strict(),
    ).max(QUOTE_ADD_MAX_FEES).optional(),
    lines: z.array(
      z.object({
        productId: z.string().trim().min(10).max(40).optional(),
        product: text.max(120).optional(),
        qty: z.number().int().min(1).max(500),
        discountPct: z.number().min(0).max(100).optional(),
        colour: text.max(60).optional(),
      }).strict(),
    ).max(QUOTE_BUILD_MAX_LINES).optional(),
    reason,
  }).strict(),
  // CHANGE what is already on a DRAFT (Sean, 2026-10-12: "change description of
  // delivery fee to Delivery Fee - Hermanus" was refused). A fee is named by its
  // current label, a line by its current description; the card builder finds the
  // one row that means and shows the change — before and after — for Confirm.
  // A product line's PRICE is not changeable here: that stays the catalogue's.
  z.object({
    type: z.literal("quote_change"),
    // Left out on a job sheet that has its quote: the CRM uses the sheet's.
    quote: text.max(40).optional(),
    fees: z.array(
      z.object({
        // Left out when the quote has only one fee: there is nothing to tell apart.
        fee: text.max(120).optional(),
        label: text.max(120).optional(),
        amount: z.number().positive().max(QUOTE_ADD_MAX_FEE_RANDS).optional(),
        remove: z.boolean().optional(),
      }).strict(),
    ).max(QUOTE_ADD_MAX_FEES).optional(),
    lines: z.array(
      z.object({
        // Left out when the quote has only one line ("make the colour white" on a quote with one vehicle).
        line: text.max(200).optional(),
        qty: z.number().int().min(1).max(500).optional(),
        discountPct: z.number().min(0).max(100).optional(),
        colour: text.max(60).optional(),
        remove: z.boolean().optional(),
      }).strict(),
    ).max(QUOTE_BUILD_MAX_LINES).optional(),
    reason,
  }).strict(),
  // "Send me the PDF of Q-1030" (Sean, 2026-10-12): the quote as it stands now, to
  // the linked WhatsApp of the person asking. It names a quote and nothing else —
  // there is no recipient to give, so it can only ever go to them.
  z.object({ type: z.literal("quote_pdf"), quote: text.max(40), reason }).strict(),
  // A question to run later, as the person — no lead: it names its own subject.
  // Cross-field rules (weekday only for weekly…) are checked by scheduleInput
  // when it becomes a card and again when it is saved.
  z.object({ type: z.literal("schedule"), ...scheduleFields, reason }).strict(),
  // "Tell me when…" — checked by fixed rules every half hour; it only ever
  // notifies the person who confirmed it (assistantWatch).
  z.object({ type: z.literal("watch"), ...watchFields, reason }).strict(),
  // Proactive DAX, part 3: a check DAX sets ITSELF — no card, no Confirm (it only ever tells the same person);
  // taken out before the cards are made and saved by proactiveFollowUp.setCheckBacks.
  z.object({ type: z.literal("check_back"), question: text.max(300), when: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/), reason }).strict(),
]);
export type ProposedAction = z.infer<typeof proposedAction>;

export const MAX_ACTIONS = 4;

/**
 * Building a quote (Sean, 2026-10-12: "DAX must be able to generate a quote for
 * a customer, asking all the questions and deliver the PDF to WhatsApp, but
 * NEVER send to customer").
 */
export const QUOTE_BUILD_RULE =
  "- quote_build: BUILD a draft quote with its lines, when they ask you to quote someone (\"quote Erik for a Rover XL\", \"do a quote for two Nomads for Anna\"). " +
  "ASK FIRST for everything you do not have, all in one message: which customer, which product(s), how many of each, any discount (a percentage, per line), and the colour if they want one. " +
  "A QUOTE IS FOR A CUSTOMER — A LEAD IS NOT REQUIRED. An existing customer who wants another quote is existing business: quote them directly with contactId (lead_brief lists matching customers with their contactId when there is no lead). Use leadId instead only when the quote is for one of their open deals — the two are different ids and are never interchangeable: a contactId goes ONLY in contactId, a leadId ONLY in leadId, and a task gives one of them, not both; if they have several open deals and it is not clear which, ask which one or whether it is separate from all of them. Never say a lead is needed, and never tell them to create one first. " +
  "Products come ONLY from the catalogue. ALWAYS look the catalogue up with knowledge BEFORE you answer anything about a quote — never say you cannot verify a product without having looked. Name each line's product by its productId from those results (or, failing that, \"product\" with its name exactly as the catalogue lists it). If what they named is not in the catalogue, say so and list what is. " +
  "A COLOUR the product does not come in is not a dead end: ask with the nearest one it does (\"Dove gray\" → \"It comes in Gray — is that the one?\"), and carry on with everything else meanwhile. " +
  "A CUSTOMER NOT FOUND by the exact name may be a misspelling (a voice note often is): when lead_brief gives closeMatches, ask \"Did you mean …?\" — never say there is no such customer. " +
  "The price is always the catalogue's: never put a price in the task, and if they want a different price, a once-off product line or a deposit, tell them that part is done on the quote in the CRM after it is created. A FEE SAID WITH THE REQUEST (delivery, licensing, admin — \"delivery to Hermanus is R6 500\") goes IN the same quote_build as \"fees\" ([{\"label\":\"Delivery — Hermanus\",\"amount\":6500,\"delivery\":true}]), so ONE Confirm makes the whole quote; quote_add is only for a fee added to a draft that already exists. " +
  "A DEAL WITH NO CUSTOMER RECORD can still be quoted: give its leadId — Confirm creates the customer from the deal first, and the card says so. " +
  "When the person has said yes to everything you asked, PROPOSE the quote_build in that same answer — do not ask them to confirm in words again; the Confirm button is the confirmation. " +
  `At most ${QUOTE_BUILD_MAX_LINES} lines. One quote per task. ` +
  "Confirming creates a DRAFT quote for that customer (on the deal, when one was named); the PDF comes back to THEM on their linked WhatsApp. " +
  "THE PDF IS DELIVERED FOR YOU, as its own document message, moments after they press Confirm, and again after a quote_add — you do not attach it yourself. So never say a PDF cannot be sent or attached on WhatsApp. If they ask where it is: it follows the confirmation, it is retried automatically for a day if WhatsApp was unavailable, and the quote is in the CRM meanwhile. To send one again, or the PDF of any quote they can open, propose quote_pdf. " +
  "It is NEVER sent to the customer and never marked sent: do not offer to send it, email it or WhatsApp it to the customer — sending a quote is their own step in the CRM. " +
  "quote (no lines) is only for \"start a quote\" with nothing said about what goes on it.";

/** Adding to a draft quote (Sean, 2026-10-12: "Please add R5000 Delivery Fee to the quote"). */
export const QUOTE_ADD_RULE =
  "- quote_add: ADD to a quote that is still a DRAFT, when they ask (\"add R5000 delivery fee to the quote\", \"put another Nomad on Q-1030\"). \"quote\" is its number (Q-1030) — the one you were just talking about, and ask which if that is not clear. " +
  "A fee goes in \"fees\": its label in their words, and \"amount\" in RANDS exactly as THEY said it (R5000 → 5000) — never an amount you worked out or assumed, and ask if they gave none; \"delivery\":true when it is a delivery charge. " +
  "A product goes in \"lines\", exactly as on quote_build: catalogue products at the catalogue price, looked up first. " +
  "It only ADDS — to change or remove something already on the quote, use quote_change. It cannot set a product's price or add a deposit: say those are done on the quote in the CRM. Never say you cannot add a fee or a line to a draft quote. " +
  "Only a draft: a quote already sent, signed or out for signature cannot be added to — say so. Confirming saves it and sends the updated PDF to THEM on their linked WhatsApp, never to the customer. " +
  "Do not state a new total yourself — the card and the PDF carry it.";

/** Changing what is on a draft quote (Sean, 2026-10-12: "change description of delivery fee to Delivery Fee - Hermanus"). */
export const QUOTE_CHANGE_RULE =
  "- quote_change: CHANGE or REMOVE something already on a quote that is still a DRAFT (\"rename the delivery fee to Delivery Fee - Hermanus\", \"make the delivery R6000\", \"take the delivery fee off\", \"make it 3 Rovers\", \"give 5% off the Nomad\", \"change the Rover from Lava to White\", \"remove the Scout\"). \"quote\" is its number. " +
  "A fee goes in \"fees\": \"fee\" is the fee as it is called NOW (\"Delivery Fee\"), then what changes — \"label\" (its new name, in their words), \"amount\" (rands, exactly as they said it), or \"remove\":true. " +
  "A product line goes in \"lines\": \"line\" is the product as it is on the quote now, then \"qty\", \"discountPct\", \"colour\" (one the product comes in) or \"remove\":true. Only what they asked to change. " +
  "The quote's lines and fees are in the quote results (\"lines\", \"fees\") — find_quotes with its number returns them, and so does a customer's record; name the row as it is written there when you can see it. " +
  "IF YOU CANNOT SEE WHAT IS ON THE QUOTE, PROPOSE THE CHANGE ANYWAY with what they said (\"fee\":\"delivery fee\"): the CRM finds the row itself, and tells them — with the fees and lines that ARE there — if it cannot. Not being able to see the lines, the fee label or the status is never a reason to hold back or to ask them. NEVER ask the person for a screenshot, or to tell you what is on a quote, or what its status is. " +
  "WHEN THE QUOTE HAS ONLY ONE LINE (or only one fee), that is the one they mean: leave \"line\" (or \"fee\") out and do not ask which. Ask which only when there are several and what they said does not single one out. " +
  "If it is already the way they asked (the colour is already White), say so and propose nothing. " +
  "It cannot set a product's price (that is the catalogue's), change the customer, the expiry, the terms or the deposit — say those are done on the quote in the CRM. " +
  "Only a draft. Never add a second fee to \"rename\" one, and never say you cannot rename, change or remove a fee or a line on a draft quote. " +
  "Confirming saves it and sends the updated PDF to THEM on their linked WhatsApp, never to the customer. Do not state a new total yourself.";

/** A quote's PDF, to the person asking (Sean, 2026-10-12: want a "send me the PDF of Q-1030" task). */
export const QUOTE_PDF_RULE =
  "- quote_pdf: SEND THEM a quote's PDF, when they ask for it (\"send me the PDF of Q-1030\", \"can I have that quote as a PDF\"). \"quote\" is its number. " +
  "It goes to THEIR OWN linked WhatsApp, as the quote stands now — draft or not. It is never sent to the customer and changes nothing on the quote: " +
  "if they want it sent to the customer, that is their own step in the CRM. Never say you cannot send a quote's PDF.";

/**
 * CHECKING BACK (proactive DAX, part 3 — Sean, 2026-10-18: "Yes, it checks back"). Offered only when the person
 * has proactive DAX on. Unlike every other task it needs no Confirm: it only ever reports back to them.
 */
export const CHECK_BACK_RULE = [
  "CHECKING BACK. When something is now waiting on a customer or on time — a quote just sent, a customer who said they'd decide by Friday, a test drive to follow up — and the person would clearly want to know how it turned out, you may set yourself a check, in the actions list:",
  '{"type":"check_back","question":"Has Anna Jacobs signed quote Q-1032? If not, what would be a good next step?","when":"YYYY-MM-DDTHH:MM","reason":"she said she would decide by Thursday"}',
  "- It needs no Confirm: on the day you look it up again and tell them either way. It never contacts the customer.",
  "- The question runs later with no conversation, so it must stand alone: name the customer and the quote or deal, never \"her\" or \"that one\".",
  "- when: South African time, on the hour or half past, at least an hour from now and within 30 days — the day it would actually matter.",
  "- At most ONE per answer, and only when it clearly helps. Not for something they asked you to remind them to DO (that is a follow_up), and not when they are already watching it.",
  "- Do NOT mention it in your answer — the CRM adds a line saying what was set.",
].join("\n");

/**
 * Opening a workshop job card (Automotive only — given to the answer step only when that module is on).
 * There is no booking-date field on a job card, so a day they name goes in the description.
 */
export const JOB_CARD_RULE =
  '- job_card: OPEN A WORKSHOP JOB CARD on a customer\'s own vehicle, when they ask ("book Anna\'s Nomad in for a service next Tuesday, brakes squeaking"). {"type":"job_card","vehicleId":"<id>","description":"...","priority":"low|normal|high|urgent","kmIn":12345}. ' +
  "vehicleId is the vehicleId of the customer's vehicle from the vehicles lookup (kind customer) — never invent one. " +
  "IF THE CUSTOMER HAS MORE THAN ONE VEHICLE and what they said does not single one out (model, reg), ASK WHICH — with CHOICES naming each by model and reg — and propose nothing until they say; never guess. If they have none on record, say so: the vehicle is added in the CRM first. " +
  "description: the work in their words. The job card has no booking date: a day they name goes in the description (\"Booked in for Tue 3 Nov — brakes squeaking\"). priority only when they say it is urgent or can wait (default normal); kmIn only when they give the odometer reading. " +
  "Confirming opens the job card in the workshop and nothing else — the customer is not contacted.";

export const ACTION_INSTRUCTIONS = [
  "TASKS. You can't change anything yourself, but you can PROPOSE up to 4 tasks for the person to confirm with one click. Propose when they ask you to do something (\"remind me…\", \"give it to Donovan\", \"draft a message…\", \"book Anna a test drive\"), or offer one when you recommend a concrete next step.",
  'Put them under "actions" in the reply block:',
  '"actions":[{"type":"follow_up","leadId":"<id>","when":"YYYY-MM-DDTHH:MM","activity":"call|whatsapp|email|meeting|todo","summary":"...","reason":"why this helps"},{"type":"note","leadId":"<id>","text":"...","pin":false},{"type":"customer_note","contactId":"<id>","text":"...","pin":false},{"type":"assign","leadId":"<id>","to":"<person>"},{"type":"stage","leadId":"<id>","stage":"<stage>"},{"type":"draft_message","leadId":"<id>","channel":"whatsapp|email","subject":"<email only>","body":"..."},{"type":"meeting","leadId":"<id>","when":"YYYY-MM-DDTHH:MM","minutes":60,"with":["<colleague>"],"summary":"..."},{"type":"test_drive","leadId":"<id>","when":"YYYY-MM-DDTHH:MM","minutes":60,"vehicle":"<demo vehicle name>"},{"type":"reschedule","activityId":"<id>","when":"YYYY-MM-DDTHH:MM"},{"type":"cancel_activity","activityId":"<id>"},{"type":"lost","leadId":"<id>","reason":"..."},{"type":"quote","leadId":"<id>"},{"type":"quote_build","contactId":"<the contactId of a CUSTOMER — a quote for the customer, on no deal>","lines":[{"productId":"<id>","qty":1,"discountPct":0,"colour":"<optional>"}]},{"type":"quote_build","leadId":"<the leadId of a DEAL — a quote for that deal; give no contactId>","lines":[{"productId":"<id>","qty":1,"colour":"<as the catalogue lists it>"}],"fees":[{"label":"Delivery — Hermanus","amount":6500,"delivery":true}]},{"type":"quote_add","quote":"Q-1030","fees":[{"label":"Delivery fee","amount":5000,"delivery":true}],"lines":[{"productId":"<id>","qty":1}]},{"type":"quote_change","quote":"Q-1030","fees":[{"fee":"Delivery Fee","label":"Delivery Fee - Hermanus"}],"lines":[{"line":"<product on the quote>","qty":3}]},{"type":"quote_pdf","quote":"Q-1030"},{"type":"schedule","question":"...","cadence":"once|daily|weekdays|weekly","weekday":1,"timeOfDay":"HH:MM","onDate":"YYYY-MM-DD"},{"type":"watch","kind":"quote_viewed|quote_unsigned|lead_quiet|test_drive_no_follow_up|delivery_deposit_due","quoteId":"Q-1042","leadId":"<id>","product":"<product>","thresholdHours":48,"thresholdDays":3}]',
  "- Add a short \"reason\" (under 160 characters) on any proposal when you know why it helps — the card shows it so the person sees the point before confirming. Skip it when the title already says everything.",
  "- watch: when they say \"tell me when / let me know if\" something happens — quote_viewed (quoteId: the customer opens that quote), quote_unsigned (viewed but not signed after thresholdHours; one quoteId or all theirs), lead_quiet (no customer contact for thresholdDays; one leadId, or every open lead for a product), test_drive_no_follow_up (a test drive done thresholdHours ago with nothing planned next), delivery_deposit_due (delivery within thresholdHours and no deposit). Only the fields that kind uses. It only ever tells THEM — it never contacts a customer. Offer one yourself when it would help (\"I can tell you when Anna opens it\").",
  "- schedule: a question for you to answer on your own LATER or REPEATEDLY (\"every Monday at 7 tell me which deals went quiet\", \"Friday at 9, has Anna signed?\"). weekday (0 = Sunday … 6 = Saturday) only with weekly; onDate only with once. Schedules run on the hour or half past, so timeOfDay is always HH:00 or HH:30 — if they ask for 07:10, propose 07:00 and say it runs on the half hour. It runs later with no conversation, so the question must stand alone — name the customer or thing (\"Has Anna Jacobs signed her quote?\"), never \"her\" or \"that deal\". No leadId. A plain reminder to do something with a lead (\"remind me to call Anna Friday\") is a follow_up, not a schedule.",
  "- meeting / test_drive: check the calendar (schedule) and, for a test drive, the demo vehicle's bookings (vehicles kind demo) BEFORE proposing — never a slot that clashes. vehicle is the demo vehicle's name exactly as listed. reschedule / cancel_activity need an activity id from the results.",
  "- lost: only when the person says the deal is lost or asks you to close it; the reason in their words. quote: starts a draft quote on the lead for them to fill in — nothing is sent.",
  QUOTE_BUILD_RULE,
  QUOTE_ADD_RULE,
  QUOTE_CHANGE_RULE,
  QUOTE_PDF_RULE,
  "- note goes on a lead. customer_note goes on a CUSTOMER — use it when they say \"customer\" or \"contact\", or when the person has no lead (lead_brief lists matching customers with their contactId when no lead matches). If several customers match, ask which one before proposing. pin:true only when they ask for the note to be pinned; it keeps it at the top of the timeline.",
  "- MISSING DETAILS: when a task needs something they have not told you — what to call it, the day or time, how long, why, which customer, who to give it to — ASK for exactly that in one short question, and offer choices where there are obvious ones (CHOICES). Ask for everything that is missing at once rather than one thing per message. Propose the task as soon as you have what it needs. Never invent a required detail, never guess a time, and never refuse or say it cannot be done because a detail is missing.",
  "- contactId, like leadId, must be an id that appears in the CRM results above.",
  '- block_time: a PERSONAL calendar item — time blocked on the person\'s own calendar, with no lead or customer ("block tomorrow 9 to 11 for admin", "I\'m at the dentist Friday afternoon", "put me down as on leave next week"). {"type":"block_time","when":"YYYY-MM-DDTHH:MM","minutes":120,"summary":"Admin","note":"why the time is unavailable"}; a date with no time ("when":"YYYY-MM-DD", optional "until":"YYYY-MM-DD") blocks whole days. note is required — use their own words for why, and ask if they gave none. Check the calendar (schedule) first: it is refused if it clashes with something already booked. It is only ever for the person asking; you cannot block a colleague\'s calendar. Never tell them a personal item is impossible or needs a lead.',
  "- leadId and activityId must be ids that appear in the CRM results above — never invent one. If you don't have it, look the lead up first or don't propose.",
  "- People and stages exactly as listed. Times are South African time.",
  "- draft_message: write it in the business's voice, ready to send. The person reads it, can edit it, and sends it with their own click — it never goes out on its own.",
  "- In your answer, never say you did it — say you've set it up for them to confirm.",
].join("\n");

/**
 * THE ANSWER MUST NOT SAY A TASK WAS SET UP WHEN IT WAS NOT.
 *
 * The assistant writes its answer and proposes its tasks in the same breath, so
 * the answer says "I've set that up for you to confirm" before anything has
 * checked the task. A task that then turns out to be nothing — the colour was
 * already White, the fee is not on that quote, the person may not edit it — used
 * to be dropped without a word, and the sentence stood (Sean, 2026-10-13: told a
 * colour change was waiting on his Ask page; nothing had been saved anywhere).
 *
 * THE ANSWER IS REPLACED, NOT ANNOTATED. The first fix kept the sentence and put
 * a correction under it, so the person read "I've set that up" and "NOT set up"
 * in one message (review of #882). What they are told about tasks is now written
 * from the cards that exist — never from what the assistant said it had done:
 *
 *  - some task did not become a card → the answer is: what IS waiting for
 *    Confirm (by its card's title), and what is not, with why;
 *  - no task at all, yet the words claim one was set up → the answer is that
 *    nothing was set up;
 *  - otherwise the assistant's own answer stands (null).
 *
 * `reasons` are the ones a task gave for itself; `unexplained` counts those that
 * came to nothing without one.
 */
export function settledAnswer(written: string, cards: readonly { title: string }[], reasons: readonly string[], unexplained: number): string | null {
  const failed = [...reasons];
  if (unexplained > 0) {
    failed.push(`${unexplained === 1 ? "A task" : `${unexplained} tasks`} could not be set up. Ask again with the exact details — for a quote: its number, and the fee or line as it is named on the quote.`);
  }
  const bullets = (lines: readonly string[]) => lines.map((line) => `• ${line}`).join("\n");
  if (failed.length > 0) {
    if (cards.length === 0) return `I couldn't set that up — there is nothing to confirm, and nothing was saved or changed.\n${bullets(failed)}`;
    return `Set up for you to confirm:\n${bullets(cards.map((card) => card.title))}\n\nNOT set up — nothing was saved or changed for this:\n${bullets(failed)}`;
  }
  if (cards.length === 0 && claimsSetUp(written)) {
    return "I haven't set anything up — there is nothing to confirm, and nothing was saved or changed. Tell me exactly what you want done (for a quote: its number, and what should be different) and I'll set it up for you to confirm.";
  }
  return null;
}

/**
 * Do these words tell the person a task is waiting for them to confirm?
 *
 * Only asked when NO card exists, where such a sentence cannot be true. It looks
 * for the assistant saying, of itself and in the past tense, that it set
 * something up / saved / queued / created / added / booked / scheduled it — together
 * with the waiting-to-be-confirmed part ("to confirm", "on your Ask page", "tap
 * Confirm"). Saying a thing CAN be set up, or asking a question, does not match.
 */
export function claimsSetUp(written: string): boolean {
  const text = written.replace(/[’‘]/g, "'");
  const did = /\bI(?:'ve| have)\s+(?:now\s+|just\s+|also\s+)?(?:set\b[^.?!\n]{0,80}?\bup\b|set up|saved|queued|created|added|booked|scheduled|prepared|lined up)/i;
  const waiting = /\b(?:to|can|and)\s+confirm\b|\bfor (?:you|your) (?:to confirm|confirmation)\b|\bAsk page\b|\b(?:tap|press|hit|click)\s+confirm\b|\bconfirm button\b/i;
  return text.split(/(?<=[.?!])\s+|\n+/).some((sentence) => !sentence.trim().endsWith("?") && did.test(sentence) && waiting.test(sentence))
    || (did.test(text) && /\bAsk page\b|\b(?:tap|press|hit|click)\s+confirm\b/i.test(text) && !/\?\s*$/.test(text.trim()));
}

/** A list of proposals → the valid ones. Each stands alone: one malformed entry doesn't sink the others. */
export function parseActionList(raw: unknown): ProposedAction[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => proposedAction.safeParse(item))
    .filter((r) => r.success)
    .map((r) => r.data)
    .slice(0, MAX_ACTIONS);
}

/** LEGACY: pull an old-style ACTIONS line out of the reply (see assistantReply). */
export function splitActions(reply: string): { answer: string; actions: ProposedAction[] } {
  const lines = reply.trimEnd().split("\n");
  const at = lines.findLastIndex((line) => line.trim().startsWith("ACTIONS:"));
  if (at === -1) return { answer: reply.trim(), actions: [] };
  const answer = lines.filter((_, i) => i !== at).join("\n").trim();
  let raw: unknown;
  try {
    raw = JSON.parse(lines[at].trim().slice("ACTIONS:".length).trim());
  } catch {
    return { answer, actions: [] };
  }
  return { answer, actions: parseActionList(raw) };
}

/**
 * Quick replies. When it asks the person to pick ("Anna or Ben Jacobs?", "call
 * or WhatsApp?") the options come back as buttons; tapping one sends that text
 * as their next message — exactly as if they'd typed it, so nothing new is
 * trusted. Not stored: only the latest answer's choices are worth showing.
 */
export const MAX_CHOICES = 4;
const choices = z.array(z.unknown()).max(12);
const choice = z.string().trim().min(1).max(60);

export const CHOICE_INSTRUCTIONS = [
  'CHOICES. When you ask the person to pick between a few clear options (which customer, which time slot, call or WhatsApp), also put the options under "choices" in the reply block:',
  '"choices":["Anna Jacobs","Ben Jacobs"]',
  `- 2 to ${MAX_CHOICES} options, each worded as the person's own short reply (under 60 characters). They become buttons; tapping one sends it as the person's reply.`,
  "- Each option must tell the choices apart on its own — by what differs (stage, value, date, product, who owns it): \"Anna Jacobs — Quoted, R235k\", never \"The first one\". If the records are duplicates that can't be told apart, say so instead of offering buttons.",
  "- Still ask the question in your answer. No choices when you aren't asking them to choose, and not for confirming a proposed task — its card has its own Confirm.",
].join("\n");

/** A list of options → the valid ones (deduped, at most MAX_CHOICES; one option isn't a choice). */
export function parseChoiceList(raw: unknown): string[] {
  const list = choices.safeParse(raw);
  if (!list.success) return [];
  const valid = list.data.map((c) => choice.safeParse(c)).filter((r) => r.success).map((r) => r.data);
  const unique = [...new Set(valid)].slice(0, MAX_CHOICES);
  return unique.length >= 2 ? unique : [];
}

/** LEGACY: the reply → the answer without an old-style CHOICES line, and the valid options. */
export function splitChoices(reply: string): { answer: string; choices: string[] } {
  const lines = reply.trimEnd().split("\n");
  const at = lines.findLastIndex((line) => line.trim().startsWith("CHOICES:"));
  if (at === -1) return { answer: reply.trim(), choices: [] };
  const answer = lines.filter((_, i) => i !== at).join("\n").trim();
  let raw: unknown;
  try {
    raw = JSON.parse(lines[at].trim().slice("CHOICES:".length).trim());
  } catch {
    return { answer, choices: [] };
  }
  return { answer, choices: parseChoiceList(raw) };
}

/**
 * A proposal the server has checked and resolved (names → ids), ready for a card.
 *
 * STALE CARDS. A card can sit on screen while the record changes underneath
 * it — DAX proposes "move Anna to Quoted", someone else moves her to Won, then
 * Confirm is pressed. So a card that changes a record's state carries what it
 * expected to find (`from…`), and Confirm refuses when that's no longer true
 * rather than applying a suggestion made about a deal that has moved on.
 * Only the field the card changes is compared: a lead touched in some other
 * way (a note, being opened) doesn't make "give it to Donovan" wrong.
 */
type LeadCard = { id: string; leadId: string; leadLabel: string; title: string; reason?: string };
export type QuoteBuildLine = { productId: string; description: string; qty: number; unitPriceCents: number; discountPct: number; colour?: string };

/**
 * Which catalogue product a quote line means — by its id, or by its name.
 *
 * By NAME because the assistant does not always carry an id through a
 * conversation, and a made-up id used to drop the whole quote without a word.
 * A name must mean exactly ONE product to count: the same name ignoring case
 * and spacing, or failing that the only product whose name contains it
 * ("Rover XL" → "Denago Rover XL"). Two candidates, or none, is no match — a
 * guess here would put the wrong vehicle on a quote at its catalogue price.
 */
export function matchCatalogueProduct<P extends { id: string; name: string }>(
  catalogue: readonly P[],
  line: { productId?: string; product?: string },
): P | null {
  if (line.productId) {
    const byId = catalogue.find((product) => product.id === line.productId);
    if (byId) return byId;
  }
  const squash = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
  const wanted = squash(line.product ?? "");
  if (!wanted) return null;
  const exact = catalogue.filter((product) => squash(product.name) === wanted);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const containing = catalogue.filter((product) => squash(product.name).includes(wanted));
  return containing.length === 1 ? containing[0] : null;
}

/**
 * A built quote, as the person reads it before confirming: one line each, at
 * the CATALOGUE price, with any discount said. No grand total: VAT, fees and
 * deposit are worked out by the quote itself once it exists, and a figure
 * computed here could disagree with the document.
 */
export function quoteBuildText(
  lines: readonly QuoteBuildLine[],
  money: (cents: number) => string,
  extra: { fees?: readonly QuoteAddFee[]; newCustomer?: string } = {},
): string {
  return [
    ...lines.map((line) =>
      `${line.qty} × ${line.description}${line.colour ? ` (${line.colour})` : ""} — ${money(line.unitPriceCents)} each${line.discountPct > 0 ? `, less ${line.discountPct}%` : ""}`,
    ),
    ...(extra.fees ?? []).map((fee) => `${fee.delivery ? "Delivery" : "Fee"}: ${fee.label} — ${money(fee.amountCents)}`),
    ...(extra.newCustomer ? [`${extra.newCustomer} becomes a customer record too (from the deal's details) — the deal has none yet.`] : []),
    "Catalogue prices. Created as a DRAFT — it is not sent to the customer.",
  ].join("\n");
}

/**
 * One change to a row that is already on a draft quote. `was` is the row as the
 * card showed it: the save makes the change only if the row still reads that
 * way under its lock, so what is confirmed is what was shown.
 */
export type QuoteChange =
  | { row: "fee"; id: string; was: { label: string; amountCents: number }; remove?: true; label?: string; amountCents?: number }
  | { row: "line"; id: string; was: { description: string; qty: number; discountPct: number; colour: string | null }; remove?: true; qty?: number; discountPct?: number; colour?: string };

/**
 * Which ONE row a name means: the same text ignoring case and spacing, or
 * failing that the only one containing it. Two candidates, or none, is no match —
 * a guess here would rename or remove the wrong line.
 */
export function matchQuoteRow<R>(rows: readonly R[], nameOf: (row: R) => string, wanted: string): R | null {
  const squash = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
  const target = squash(wanted);
  if (!target) return null;
  const exact = rows.filter((row) => squash(nameOf(row)) === target);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const containing = rows.filter((row) => squash(nameOf(row)).includes(target));
  return containing.length === 1 ? containing[0] : null;
}

/** What a quote_change card changes, as the person reads it before confirming: each row before and after. */
export function quoteChangeText(changes: readonly QuoteChange[], money: (cents: number) => string): string {
  return [
    ...changes.map((change) => {
      if (change.row === "fee") {
        const was = `Fee "${change.was.label}" (${money(change.was.amountCents)})`;
        if (change.remove) return `Remove: ${was}`;
        return `${was} → "${change.label ?? change.was.label}" (${money(change.amountCents ?? change.was.amountCents)})`;
      }
      const line = (qty: number, colour: string | null, discount: number) =>
        `${qty} × ${change.was.description}${colour ? ` (${colour})` : ""}${discount > 0 ? `, less ${discount}%` : ""}`;
      const was = line(change.was.qty, change.was.colour, change.was.discountPct);
      if (change.remove) return `Remove: ${was}`;
      return `${was} → ${line(change.qty ?? change.was.qty, change.colour ?? change.was.colour, change.discountPct ?? change.was.discountPct)}`;
    }),
    "Changed on the DRAFT — nothing else on it changes, and it is not sent to the customer.",
  ].join("\n");
}

/**
 * The key a quote card is confirmed with — minted on the server when the card is
 * made, and spent in the transaction that carries the card out, so a second
 * Confirm of the same card changes nothing (app/actions/quotes.ts claimConfirmKey).
 */
export const CONFIRM_KEY = /^qk_[a-f0-9]{32}$/;
export type QuoteAddFee ={ label: string; amountCents: number; delivery: boolean };
/** What a quote_add card adds, as the person reads it before confirming. */
export function quoteAddText(lines: readonly QuoteBuildLine[], fees: readonly QuoteAddFee[], money: (cents: number) => string): string {
  return [
    ...fees.map((fee) => `${fee.delivery ? "Delivery" : "Fee"}: ${fee.label} — ${money(fee.amountCents)}`),
    ...lines.map((line) =>
      `${line.qty} × ${line.description}${line.colour ? ` (${line.colour})` : ""} — ${money(line.unitPriceCents)} each${line.discountPct > 0 ? `, less ${line.discountPct}%` : ""}`,
    ),
    "Added to the DRAFT — nothing already on it changes, and it is not sent to the customer.",
  ].join("\n");
}

export const STALE_CARD ="This changed since DAX suggested it — ask again to see where it stands now.";
export type ActionCard =
  | (LeadCard & { kind: "follow_up"; when: string; activity: string; summary?: string })
  | (LeadCard & { kind: "note"; text: string; pin?: boolean })
  // leadId null and leadLabel the customer's name: the same shape an activity with no lead has.
  | { id: string; kind: "customer_note"; contactId: string; leadId: null; leadLabel: string; title: string; text: string; pin?: boolean; reason?: string }
  | (LeadCard & { kind: "assign"; userId: string; fromUserId: string | null })
  | (LeadCard & { kind: "stage"; stageId: string; fromStageId: string })
  | (LeadCard & { kind: "draft_message"; channel: "whatsapp" | "email"; subject?: string; body: string; to: string | null })
  | (LeadCard & { kind: "meeting"; start: string; end: string; summary: string; attendeeIds: string[]; detail: string })
  | (LeadCard & { kind: "test_drive"; contactId: string; demoVehicleId: string; branch: string; start: string; end: string; detail: string })
  // leadId null and leadLabel the vehicle's owner. contactId is the owner the card SHOWED: Confirm refuses if it changed.
  | { id: string; kind: "job_card"; leadId: null; leadLabel: string; title: string; vehicleId: string; contactId: string; description: string; priority: "low" | "normal" | "high" | "urgent"; kmIn?: number; detail: string; reason?: string; confirmKey: string }
  | (LeadCard & { kind: "lost"; reason: string })
  | (LeadCard & { kind: "quote" })
  // `text` is the whole quote as the person reads it before confirming (lines, catalogue prices, discounts).
  // `lines` carries the catalogue price each was SHOWN at, so a price that changed since is caught at Confirm.
  // leadId null: a quote for the customer directly, on no deal — leadLabel is then the customer's name.
  // `confirmKey`: this card is carried out once, however often Confirm reaches the server (CONFIRM_KEY).
  // contactId null + createCustomer: the deal has no customer yet — Confirm makes one from its details first.
  // `taskId`: the job sheet it came from (assistantTask) — Confirm records the result there. Untrusted like the rest of the card.
  | { id: string; kind: "quote_build"; leadId: string | null; leadLabel: string; title: string; reason?: string; contactId: string | null; createCustomer?: true; lines: QuoteBuildLine[]; fees?: QuoteAddFee[]; text: string; confirmKey: string; taskId?: string }
  // An addition to a DRAFT quote: `fees` at the amount the person said, `lines` at the catalogue price each was shown at.
  | { id: string; kind: "quote_add"; leadId: string | null; leadLabel: string; title: string; reason?: string; quoteId: string; quoteNumber: number; contactId: string; lines: QuoteBuildLine[]; fees: QuoteAddFee[]; text: string; confirmKey: string; taskId?: string }
  // Changes to rows already on a DRAFT quote, each with the row as it was shown (`was`).
  | { id: string; kind: "quote_change"; leadId: string | null; leadLabel: string; title: string; reason?: string; quoteId: string; quoteNumber: number; contactId: string; changes: QuoteChange[]; text: string; confirmKey: string; taskId?: string }
  // A quote's PDF to the confirmer's own linked WhatsApp — the card names a quote, never a recipient.
  | { id: string; kind: "quote_pdf"; leadId: string | null; leadLabel: string; title: string; reason?: string; quoteId: string; quoteNumber: number }
  // The person's own calendar, never somebody else's: nothing on the card says whose it is, so it can only be the confirmer's.
  | { id: string; kind: "block_time"; leadId: null; leadLabel: string; title: string; allDay: boolean; start: string; end: string; summary: string; detail: string; reason?: string }
  | { id: string; kind: "reschedule"; activityId: string; title: string; when: string; leadId: string | null; leadLabel: string; fromDue: string; reason?: string }
  | { id: string; kind: "cancel_activity"; activityId: string; title: string; leadId: string | null; leadLabel: string; fromDue: string; reason?: string }
  | { id: string; kind: "schedule"; title: string; question: string; cadence: Cadence; weekday?: number; timeOfDay: string; onDate?: string; reason?: string }
  | { id: string; kind: "watch"; title: string; watch: WatchInput; reason?: string };

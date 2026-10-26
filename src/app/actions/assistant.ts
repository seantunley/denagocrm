"use server";

import { requireAnyPermission } from "@/lib/permissions";
import { withActingStaffScope } from "@/lib/actingScope";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { assistantTurnsToday } from "@/lib/crmAssistant";
import { getSetting } from "@/lib/settings";
import { isCodexConnected } from "@/lib/codex";
import { ASSISTANT_PROFILE_KEY, parseProfile } from "@/lib/assistantSoul";
import { CONFIRM_KEY, QUOTE_ADD_MAX_FEES, QUOTE_ADD_MAX_FEE_RANDS, QUOTE_BUILD_MAX_LINES, STALE_CARD, type ActionCard } from "@/lib/assistantActions";
import { editorDefaults, quoteFromLeadDefaults } from "@/lib/quoteFromLead";
import { QUOTE_PDF_SOURCE } from "@/lib/assistantWhatsAppRules";
import { tenantOrigin } from "@/lib/tenantOrigin";
import { payableTotalCents } from "@/lib/pricing";
import { formatZAR } from "@/lib/format";

/** How long a Confirm in the CRM waits for a built quote's PDF to go to WhatsApp before leaving it to the sweep. */
const QUOTE_PDF_SEND_WAIT_MS = 4_000;
import { prisma } from "@/lib/db";
import { cancelActivity, rescheduleActivity, scheduleActivity, scheduleFollowUp } from "@/app/actions/activities";
import { addCommunication } from "@/app/actions/communications";
import { assignLead, convertLeadToContact, markLost, moveLead } from "@/app/actions/leads";
import { createQuoteFromLead, saveQuoteDraft } from "@/app/actions/quotes";
import { createTestDriveBooking } from "@/app/actions/testDrives";
import { createStaffAvailability } from "@/app/actions/staffAvailability";
import { sendWhatsAppMessage } from "@/app/actions/whatsapp";
import { sendEmailAction } from "@/app/actions/emails";
import { canAccessContact, canAccessLead, canAccessQuote, hasPermission } from "@/lib/permissions";
import { createWatchForUser } from "@/lib/assistantWatch";
import { recordTaskProgress } from "@/lib/assistantTask";
import { assistantVoiceRepliesOn } from "@/lib/assistantVoice";
import { ASSISTANT_PERMISSIONS } from "@/lib/assistantUser";
import { MAX_ACTIVE_SCHEDULES, describeSchedule, nextRun, scheduleInput } from "@/lib/assistantSchedule";
import { markScheduledTurnsSeen, withScheduleSlot } from "@/lib/assistantScheduleRun";
import { ownedWriteTenantId } from "@/lib/tenantWrite";
import { logAudit } from "@/lib/audit";
import { logError } from "@/lib/errorLog";
import { revalidatePath } from "next/cache";

/**
 * Run a task the assistant proposed, AFTER the person pressed Confirm on it.
 *
 * Deliberately thin: each kind hands straight to the action a person would use
 * by hand — scheduleFollowUp, addCommunication, assignLead, moveLead — so that
 * action's own permission check, lead-access check, stage gates and audit entry
 * all apply unchanged. The card came from the browser, so nothing in it is
 * trusted beyond what those actions re-check. A draft message is never sent
 * from here: the person copies it into the conversation and sends it there.
 */
/**
 * A refusal made BEFORE anything that writes was called: the card was out of
 * date, the lead is gone, the schedule was invalid. `unchanged` is the proof a
 * caller needs before it may offer the same task again (confirming on WhatsApp
 * does). It is NEVER set on an error that came back from the action a card hands
 * to: that action may have written part of its work before failing — a note
 * saved and its pin failed is the case that showed it — so such an error says
 * only "not completed", not "nothing happened".
 */
const untouched = (error: string) => ({ ok: false as const, error, unchanged: true as const });
/**
 * Part of it WAS written, and confirming the same card again is still safe —
 * because the retry finds what was written and does not write it twice. One use
 * (review of #905, 2026-10-25): a quote for a deal with no customer made the
 * customer record, then the quote was refused. The retry finds the deal now
 * linked to that customer (no second record), and the card's confirm key makes
 * at most one quote. The callers release the claim on this as on `unchanged`,
 * but say what was done.
 */
const resumable = (error: string) => ({ ok: false as const, error, resumable: true as const });

export async function runAssistantAction(
  card: ActionCard,
  /**
   * Where Confirm was pressed. It decides one thing: who sends a built quote's
   * PDF to the person's linked phone — this action ("crm"), or the WhatsApp door
   * after its own reply ("whatsapp"). Either way it is queued first, so a wrong
   * value here can only make the PDF arrive by the half-hourly sweep instead.
   */
  via: "crm" | "whatsapp" = "crm",
  /** `quote`: the draft a quote_build created. */
): Promise<{ ok: boolean; error?: string; success?: string; href?: string; unchanged?: boolean; resumable?: boolean; quote?: { id: string; number: number } }> {
  return withActingStaffScope(async () => {
    const user = await requireAnyPermission(...ASSISTANT_PERMISSIONS);
    if (!(await isModuleEnabled("automation"))) {
      return untouched("Ask the CRM is part of the Automation & AI module, which is off for this workspace.");
    }
    // The action it hands to writes its own audit entry; this one records that
    // the change came from the assistant's proposal, on the lead's timeline.
    const confirmed = (what: string, leadId: string) =>
      logAudit({ action: "assistant.action_confirmed", summary: `Confirmed the assistant's proposal: ${what}`, user, leadId });
    // A quote's PDF queued for this person (saveQuoteDraft, pdfToMyWhatsApp): when
    // Confirm was pressed in the CRM, try the send now, briefly — the click does
    // not wait on WhatsApp, and whatever is not sent in that time is the sweep's.
    // (On WhatsApp the caller sends it itself, after its own "done" message.)
    // Nothing here may fail the action: the quote is saved.
    const sendQueuedPdfNow = async () => {
      if (via !== "crm") return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        (async () => {
          const { sendUpdatesToLinkedPhone } = await import("@/lib/assistantWhatsApp");
          return sendUpdatesToLinkedPhone(ownedWriteTenantId(), user.id);
        })().catch(() => "failed" as const),
        new Promise((resolve) => { timer = setTimeout(resolve, QUOTE_PDF_SEND_WAIT_MS); }),
      ]);
      clearTimeout(timer);
    };
    switch (card?.kind) {
      case "schedule": {
        // Saved for the SIGNED-IN person, always: nothing on the card says who
        // it is for, and the run re-checks them (assistantUserFor) every time.
        // The timing is re-validated and nextRunAt worked out here, not taken
        // from the browser.
        const parsed = scheduleInput.safeParse({
          question: card.question, cadence: card.cadence, weekday: card.weekday, timeOfDay: card.timeOfDay, onDate: card.onDate,
        });
        if (!parsed.success) return untouched("That schedule isn't valid — ask again.");
        const nextRunAt = nextRun(parsed.data, new Date());
        if (!nextRunAt) return untouched("That time has already passed — ask again with a new one.");
        const tenantId = ownedWriteTenantId();
        const saved = await withScheduleSlot(user.id, (tx) =>
          tx.assistantSchedule.create({
            data: { tenantId, userId: user.id, ...parsed.data, weekday: parsed.data.weekday ?? null, onDate: parsed.data.onDate ?? null, nextRunAt },
            select: { id: true },
          }),
        );
        if (!saved) {
          return { ok: false, error: `You already have ${MAX_ACTIVE_SCHEDULES} scheduled questions — pause or delete one on the Ask page first.` };
        }
        const when = describeSchedule(parsed.data);
        // The timing in the trail, not the question: it may name a customer.
        await logAudit({ action: "assistant.schedule_created", summary: `Scheduled a question for the assistant (${when})`, user, entityType: "AssistantSchedule", entityId: saved.id });
        revalidatePath("/assistant");
        return { ok: true, success: `Scheduled: ${when}. Manage it on the Ask page.` };
      }
      case "watch": {
        // For the SIGNED-IN person, always; it validates, checks they can open
        // the lead or quote, enforces their cap and audits (assistantWatch).
        const saved = await createWatchForUser(user, card.watch);
        if (!saved.ok) return { ok: false, error: saved.error };
        revalidatePath("/assistant");
        return { ok: true, success: "Watching — it only ever tells you. Manage it on the Ask page." };
      }
      case "follow_up": {
        const lead = await prisma.lead.findUnique({ where: { id: card.leadId }, select: { contactId: true } });
        if (!lead) return untouched("That lead is no longer there.");
        const result = await scheduleFollowUp({
          leadId: card.leadId,
          contactId: lead.contactId,
          type: card.activity,
          when: card.when,
          summary: card.summary,
        });
        if (!result.ok) return { ok: false, error: result.error ?? "Couldn't schedule it." };
        await confirmed(`schedule a ${card.activity}`, card.leadId);
        return { ok: true, success: "Follow-up scheduled" };
      }
      case "note": {
        const form = new FormData();
        form.set("leadId", card.leadId);
        form.set("body", card.text);
        form.set("type", "note");
        // addCommunication's own pin: the same switch the note box has.
        if (card.pin === true) form.set("pin", "on");
        form.set("revalidate", `/leads/${card.leadId}`);
        const result = await addCommunication(form);
        if (result?.error) return { ok: false, error: result.error };
        await confirmed(`add a note${card.pin === true ? " (pinned)" : ""}`, card.leadId);
        return { ok: true, success: card.pin === true ? "Note added and pinned" : "Note added" };
      }
      case "customer_note": {
        // On the customer, not a deal. addCommunication checks that this person
        // may write to customer records and can open THIS customer.
        const form = new FormData();
        form.set("contactId", card.contactId);
        form.set("body", card.text);
        form.set("type", "note");
        if (card.pin === true) form.set("pin", "on");
        form.set("revalidate", `/contacts/${card.contactId}`);
        const result = await addCommunication(form);
        if (result?.error) return { ok: false, error: result.error };
        await logAudit({
          action: "assistant.action_confirmed",
          summary: `Confirmed the assistant's proposal: add a note${card.pin === true ? " (pinned)" : ""}`,
          user,
          contactId: card.contactId,
        });
        return { ok: true, success: card.pin === true ? "Note added and pinned" : "Note added", href: `/contacts/${card.contactId}` };
      }
      case "assign": {
        if (!(await stillAsProposed(card))) return untouched(STALE_CARD);
        const result = await assignLead(card.leadId, card.userId);
        if (!result.ok) return { ok: false, error: result.error };
        await confirmed(`give the lead to ${result.assignee.name}`, card.leadId);
        return { ok: true, success: `Given to ${result.assignee.name}` };
      }
      case "stage": {
        if (!(await stillAsProposed(card))) return untouched(STALE_CARD);
        const result = await moveLead(card.leadId, card.stageId);
        if (!result.ok) return { ok: false, error: result.error ?? "That move isn't allowed yet." };
        await confirmed("move the lead to another stage", card.leadId);
        return { ok: true, success: "Lead moved" };
      }
      case "meeting": {
        const lead = await prisma.lead.findUnique({ where: { id: card.leadId }, select: { contactId: true } });
        if (!lead) return untouched("That lead is no longer there.");
        const form = new FormData();
        form.set("type", "meeting");
        form.set("summary", card.summary);
        form.set("leadId", card.leadId);
        if (lead.contactId) form.set("contactId", lead.contactId);
        form.set("dueDate", card.start);
        form.set("endDate", card.end);
        for (const id of card.attendeeIds) form.append("attendeeIds", id);
        const result = await scheduleActivity(form);
        if (result.error) return { ok: false, error: result.error };
        await confirmed("book a meeting", card.leadId);
        return { ok: true, success: "Meeting booked" };
      }
      case "test_drive": {
        const form = new FormData();
        form.set("contactId", card.contactId);
        form.set("leadId", card.leadId);
        form.set("demoVehicleId", card.demoVehicleId);
        form.set("branch", card.branch);
        form.set("scheduledStart", card.start);
        form.set("expectedReturnAt", card.end);
        const result = await createTestDriveBooking(form);
        if (result.error) return { ok: false, error: result.error };
        await confirmed("book a test drive", card.leadId);
        return { ok: true, success: result.success ?? "Test drive booked" };
      }
      case "block_time": {
        // A personal calendar item. No assignee is passed, so it is the
        // signed-in person's OWN calendar — the card cannot name anybody else's.
        // createStaffAvailability needs activities.manage, requires the note,
        // and refuses a block that clashes with something already booked.
        const form = new FormData();
        form.set("summary", card.summary);
        form.set("note", card.detail);
        if (card.allDay) {
          form.set("allDay", "on");
          form.set("startDate", card.start);
          form.set("endDate", card.end);
        } else {
          form.set("startAt", card.start);
          form.set("endAt", card.end);
        }
        const result = await createStaffAvailability(form);
        if (result.error) return { ok: false, error: result.error };
        await logAudit({ action: "assistant.action_confirmed", summary: "Confirmed the assistant's proposal: block time on their own calendar", user });
        return { ok: true, success: "Time blocked on your calendar", href: "/calendar" };
      }
      case "reschedule": {
        if (!(await stillAsProposed(card))) return untouched(STALE_CARD);
        const result = await rescheduleActivity(card.activityId, card.when);
        if (!result.ok) return { ok: false, error: result.error ?? "Couldn't move it." };
        if (card.leadId) await confirmed("reschedule an activity", card.leadId);
        return { ok: true, success: "Moved" };
      }
      case "cancel_activity": {
        if (!(await stillAsProposed(card))) return untouched(STALE_CARD);
        const result = await cancelActivity(card.activityId, "/assistant");
        if (result.error) return { ok: false, error: result.error };
        if (card.leadId) await confirmed("cancel an activity", card.leadId);
        return { ok: true, success: "Cancelled" };
      }
      case "lost": {
        if (!(await stillAsProposed(card))) return untouched(STALE_CARD);
        const form = new FormData();
        form.set("lostReason", card.reason);
        const result = await markLost(card.leadId, form);
        if (result.error) return { ok: false, error: result.error };
        await confirmed("mark the deal lost", card.leadId);
        return { ok: true, success: "Marked lost" };
      }
      case "quote": {
        const result = await createQuoteFromLead(card.leadId);
        if (result.error) return { ok: false, error: result.error };
        await confirmed("start a quote", card.leadId);
        return { ok: true, success: "Draft quote started", href: result.redirectTo };
      }
      case "quote_build": {
        // A DRAFT, and nothing more: no status change, no email, no signing
        // request. Whatever was on the card, the lines saved are the
        // catalogue's as it stands NOW — a product withdrawn or re-priced since
        // the card was shown means the person agreed to something else, and
        // nothing is created (`untouched`: it can be asked for again).
        //
        // FOR A CUSTOMER — on one of their deals, or on none. With a deal, it must
        // still be there and still be this customer's. With none, the customer must
        // still be there; saveQuoteDraft then checks this person may quote them.
        const lines = Array.isArray(card.lines) ? card.lines : [];
        if (lines.length === 0 || lines.length > QUOTE_BUILD_MAX_LINES) return untouched("That quote isn't valid — ask again.");
        // Fees said with the request, on the same draft (2026-10-24) — checked as quote_add checks them.
        const buildFees = Array.isArray(card.fees) ? card.fees : [];
        if (buildFees.length > QUOTE_ADD_MAX_FEES || buildFees.some((fee) => !Number.isInteger(fee.amountCents) || fee.amountCents <= 0 || fee.amountCents > QUOTE_ADD_MAX_FEE_RANDS * 100 || !String(fee.label ?? "").trim())) {
          return untouched("That quote isn't valid — ask again.");
        }
        // Asked here as a yes/no first: saveQuoteDraft's own check REDIRECTS, which a Confirm tapped on WhatsApp has
        // nowhere to follow — it showed as "no permission" and the card was spent (quote_add asks the same way).
        // Before anything is written — a customer record included.
        if (!(await hasPermission(user, "quotes.create"))) return untouched("Your role can't create quotes.");
        if (card.contactId && !(await canAccessContact(user, card.contactId))) return untouched("You can't create a quote for this customer — ask whoever looks after them.");
        // The catalogue as it stands now — checked BEFORE the customer record may be made below, so "nothing was
        // changed" stays true of every refusal before the save.
        const products = await prisma.product.findMany({
          where: { id: { in: [...new Set(lines.map((line) => String(line.productId)))] }, active: true, deletedAt: null },
          select: { id: true, name: true, basePriceCents: true, colors: { select: { name: true } } },
        });
        const byId = new Map(products.map((product) => [product.id, product]));
        if (lines.some((line) => byId.get(line.productId)?.basePriceCents !== line.unitPriceCents)) {
          return untouched("The catalogue changed since DAX suggested this — ask again to see today's prices.");
        }
        // The colour as saveQuoteDraft will check it (configured for the product, any case) — here, so a colour the
        // catalogue no longer has stops the Confirm BEFORE a customer record is made, not after.
        const notOffered = (line: (typeof lines)[number]) => {
          const asked = String(line.colour ?? "").trim().toLocaleLowerCase();
          return asked !== "" && !byId.get(line.productId)!.colors.some((colour) => colour.name.toLocaleLowerCase() === asked);
        };
        if (lines.some(notOffered)) return untouched("That colour isn't in the catalogue for this product any more — ask again.");
        let quoteContactId = card.contactId;
        let customerFromDeal: string | null = null;
        if (card.leadId) {
          const lead = await prisma.lead.findUnique({ where: { id: card.leadId }, select: { contactId: true } });
          if (!lead) return untouched("That lead is no longer there.");
          // The card said the deal had no customer and one would be made. Linked meanwhile = that one.
          if (card.createCustomer && !card.contactId) {
            if (lead.contactId) quoteContactId = lead.contactId;
            else customerFromDeal = card.leadId;
          } else if (!lead.contactId || lead.contactId !== card.contactId) return untouched(STALE_CARD);
        } else {
          const customer = await prisma.contact.findFirst({ where: { id: String(card.contactId ?? ""), deletedAt: null }, select: { id: true } });
          if (!customer) return untouched("That customer is no longer there.");
        }
        // The quote's defaults are READ before anything is written (second review of #905): a settings read that
        // failed between the customer record and the save spent the card with the customer standing alone.
        const defaults = await quoteFromLeadDefaults();
        // A CARD THAT MAKES ITS CUSTOMER can always be confirmed again after the save fails — on this attempt or a
        // later one (second review of #905: a second failure, on the attempt that found the customer already made,
        // spent the card). Safe because the retry finds the deal linked (no second record), a new quote's save writes
        // in ONE transaction after every refusal, and the confirm key it spends there makes a second save create nothing.
        const keyed = CONFIRM_KEY.test(String(card.confirmKey ?? ""));
        const resumes = card.createCustomer === true && !card.contactId && keyed;
        const retryAfterCustomer = (why: string) =>
          resumable(`${why} The deal's customer record is in place, but the quote wasn't saved. Confirm again to retry — the same customer is used, and nothing is made twice.`);
        // EVERY CHECK IS ABOVE: from here on things are written. The customer record first, from the deal's details,
        // by "Add to contacts" itself (its permission, identity rules and audit). Not "unchanged" if it fails: making
        // the record writes more than one row, so a failure is reported as it is.
        if (customerFromDeal) {
          const made = await convertLeadToContact(customerFromDeal);
          if (!made.ok || !made.contactId) {
            // Its refusals are written for people ("Several customers match this email…"); anything else is a
            // technical error, which is logged by name and never shown on the card.
            const readable = made.error && /^[^\n]{1,200}$/.test(made.error) && !/prisma|invocation|column|ECONN|timeout/i.test(made.error);
            if (!readable) await logError("assistant", "making a customer for a quote failed").catch(() => {});
            return { ok: false, error: readable ? `I couldn't make the customer record: ${made.error}` : "I couldn't make the customer record — add them as a customer on the deal in the CRM, then ask again." };
          }
          quoteContactId = made.contactId;
        }
        if (!quoteContactId) return { ok: false, error: STALE_CARD };
        const saved = await saveQuoteDraft({
          contactId: quoteContactId,
          leadId: card.leadId ?? null,
          ...(buildFees.length ? { fees: buildFees.map((fee) => ({ label: String(fee.label).trim(), kind: fee.delivery ? "delivery" as const : "fee" as const, amountCents: fee.amountCents })) } : {}),
          validUntil: editorDefaults(defaults).validUntil,
          terms: defaults.terms,
          intent: "draft",
          // ITS PDF, TO THEIR LINKED WHATSAPP — recorded by the save itself, in the
          // same transaction as the quote (see saveQuoteDraft): the two exist
          // together or not at all, so there is never a built quote with nothing
          // for the retrying delivery to find.
          pdfToMyWhatsApp: true,
          // ONE CONFIRM, ONE QUOTE: the card's key is spent in the transaction that
          // creates the quote, so a Confirm pressed again after a lost answer creates
          // no second quote. (A card proposed before keys existed has none, and runs as it did.)
          ...(keyed ? { confirmKey: card.confirmKey } : {}),
          items: lines.map((line) => {
            const product = byId.get(line.productId)!;
            return {
              description: product.name, qty: line.qty, unitPriceCents: product.basePriceCents, productId: product.id,
              discountPct: line.discountPct, ...(line.colour ? { colorPreference: line.colour } : {}),
            };
          }),
        }).catch(async (error: unknown) => {
          // Thrown (a database timeout, say) after the customer was made: with the key, a retry is still at most once.
          // A guard's redirect, or no customer made here, is thrown on as before.
          const redirect = typeof error === "object" && error !== null && String((error as { digest?: unknown }).digest ?? "").startsWith("NEXT_");
          if (!resumes || redirect) throw error;
          await logError("assistant", "saving a quote after making its customer failed", error instanceof Error ? error.name : "unknown").catch(() => {});
          return { ok: false as const, error: "The quote couldn't be saved just now.", thrown: true as const };
        });
        // A Confirm that reached the server twice: the first made the quote; this one did nothing.
        if (!saved.ok && "repeated" in saved && saved.repeated) return { ok: true, success: "Already created — nothing was made twice. It has NOT been sent to the customer." };
        // saveQuoteDraft validates before it writes (a colour the product does not come in, say).
        if (!saved.ok) return resumes ? retryAfterCustomer(saved.error) : { ok: false, error: saved.error };
        // On the deal's record when there is one; otherwise on the customer's.
        await logAudit({
          action: "assistant.action_confirmed",
          summary: `Confirmed the assistant's proposal: create draft quote Q-${saved.quote.number}`,
          user,
          ...(card.leadId ? { leadId: card.leadId } : { contactId: quoteContactId }),
        });
        // ON ITS JOB SHEET: the quote's id as the CRM just made it — the only way a sheet ever gets one. Never throws.
        await recordTaskProgress(user.id, card.taskId, { quoteId: saved.quote.id, done: `Draft quote Q-${saved.quote.number} created` });
        // THE QUOTE EXISTS. Everything below is about telling the person, and none
        // of it may undo that or report it as failed.
        //
        // The total as the QUOTE works it out (VAT, discounts) — read back from
        // what was saved, never computed on the side.
        const built = await prisma.quote.findUnique({ where: { id: saved.quote.id }, include: { items: true, fees: true } }).catch(() => null);
        const total = built ? formatZAR(Math.round(payableTotalCents(built))) : null;
        // ITS PDF is already queued for them: the save wrote it with the quote, as an
        // update (source "quote_pdf", naming the quote) that the assistant's own
        // delivery sends — claimed, retried by the half-hourly sweep, to a phone it
        // re-verifies and refuses if it is a customer's. So the PDF follows whether
        // they confirmed in the CRM or on WhatsApp, and is not lost if this request
        // ends before WhatsApp answers. With no linked phone it stays in their Ask
        // history, with the link.
        //
        // Confirmed in the CRM: try the send now, briefly — the click does not wait
        // on WhatsApp, and whatever is not sent in that time is the sweep's. (On
        // WhatsApp the caller sends it itself, after its own "done" message.)
        await sendQueuedPdfNow();
        return {
          ok: true,
          success: `Draft quote Q-${saved.quote.number} created${total ? ` — ${total}` : ""}. It has NOT been sent to the customer.`,
          href: `/quotes?edit=${saved.quote.id}`,
          quote: { id: saved.quote.id, number: saved.quote.number },
        };
      }
      case "quote_pdf": {
        // THEIR OWN COPY, TO THEIR OWN PHONE. The card names a quote and no
        // recipient: it is queued as an update for the signed-in person, and the
        // assistant's delivery sends it to the phone THEY linked — re-verified at
        // send time, refused if it is a customer's number, and the quote re-checked
        // against their access there too. Nothing on the quote changes.
        const quote = await prisma.quote.findFirst({ where: { id: String(card.quoteId ?? ""), deletedAt: null }, select: { id: true, number: true, status: true, leadId: true, contactId: true } });
        if (!quote || !(await canAccessQuote(user, quote.id))) return untouched("That quote is no longer there.");
        const linked = await prisma.assistantPhoneLink.findFirst({ where: { userId: user.id, verifiedAt: { not: null }, waId: { not: null } }, select: { id: true } });
        if (!linked) return untouched("Link your WhatsApp first (Ask page → DAX on WhatsApp) — the PDF goes to your own linked number.");
        const tenantId = ownedWriteTenantId();
        const origin = (await tenantOrigin(tenantId).catch(() => "")).replace(/\/$/, "");
        await prisma.assistantTurn.create({
          data: {
            tenantId,
            userId: user.id,
            source: QUOTE_PDF_SOURCE,
            quoteId: quote.id,
            question: `PDF of quote Q-${quote.number}`,
            answer: `Here is quote Q-${quote.number} as it stands now (${quote.status}). This copy has NOT been sent to the customer.\n${origin}/quotes?edit=${quote.id}`,
          },
        });
        await logAudit({
          action: "assistant.action_confirmed",
          summary: `Confirmed the assistant's proposal: send me the PDF of quote Q-${quote.number}`,
          user,
          ...(quote.leadId ? { leadId: quote.leadId } : quote.contactId ? { contactId: quote.contactId } : {}),
        });
        await sendQueuedPdfNow();
        return { ok: true, success: `The PDF of Q-${quote.number} is on its way to your WhatsApp. It has NOT been sent to the customer.`, href: `/quotes?edit=${quote.id}` };
      }
      case "quote_change": {
        // CHANGES rows already on a draft, through the quote editor's own save in
        // its change-rows mode: each row is named by id with how it read on the
        // card, and the save changes it only if it still reads that way under the
        // save's lock — so what was confirmed is what was shown. saveQuoteDraft
        // re-checks that this person may edit this quote and that it is still an
        // editable draft, and bounds every value. The card's key makes it happen once.
        if (!CONFIRM_KEY.test(String(card.confirmKey ?? ""))) return untouched(STALE_CARD);
        const changes = Array.isArray(card.changes) ? card.changes : [];
        if (changes.length === 0 || changes.length > QUOTE_ADD_MAX_FEES + QUOTE_BUILD_MAX_LINES) return untouched("That isn't valid — ask again.");
        const quote = await prisma.quote.findFirst({ where: { id: String(card.quoteId ?? ""), deletedAt: null }, select: { id: true, status: true, contactId: true, leadId: true } });
        // Asked here as a yes/no: saveQuoteDraft's own check REDIRECTS, which a Confirm tapped on WhatsApp has nowhere to follow.
        if (!quote || !(await hasPermission(user, "quotes.edit")) || !(await canAccessQuote(user, quote.id))) return untouched("That quote is no longer there.");
        if (quote.status !== "draft" || !quote.contactId) return untouched("That quote is no longer a draft, so it can't be changed from here — revise it in the CRM.");
        const saved = await saveQuoteDraft({
          id: quote.id,
          contactId: quote.contactId,
          terms: "",
          intent: "draft",
          items: [],
          changes,
          confirmKey: card.confirmKey,
          pdfToMyWhatsApp: true,
        });
        if (!saved.ok && saved.repeated) return { ok: true, success: "Already changed — nothing was done twice. It has NOT been sent to the customer.", href: `/quotes?edit=${quote.id}` };
        if (!saved.ok) return { ok: false, error: saved.error };
        await logAudit({
          action: "assistant.action_confirmed",
          summary: `Confirmed the assistant's proposal: change draft quote Q-${saved.quote.number}`,
          user,
          ...(quote.leadId ? { leadId: quote.leadId } : { contactId: quote.contactId }),
        });
        await recordTaskProgress(user.id, card.taskId, { done: `Q-${saved.quote.number} changed` });
        const after = await prisma.quote.findUnique({ where: { id: quote.id }, include: { items: true, fees: true } }).catch(() => null);
        const total = after ? formatZAR(Math.round(payableTotalCents(after))) : null;
        await sendQueuedPdfNow();
        return {
          ok: true,
          success: `Draft quote Q-${saved.quote.number} changed${total ? ` — now ${total}` : ""}. It has NOT been sent to the customer.`,
          href: `/quotes?edit=${quote.id}`,
          quote: { id: quote.id, number: saved.quote.number },
        };
      }
      case "quote_add": {
        // ADDS to a draft, through the same door the quote editor saves through, in
        // its ADD-ONLY mode: only the new fees and lines are sent, and they are
        // added inside the save's own lock on the quote — nothing already on it is
        // read here, sent back or rewritten, so an edit somebody else saves a moment
        // before cannot be undone by this. saveQuoteDraft re-checks that this person
        // may edit this quote and that it is still an editable draft — sent, signed
        // or out for signature refuses. The card's key makes it happen once.
        if (!CONFIRM_KEY.test(String(card.confirmKey ?? ""))) return untouched(STALE_CARD);
        const fees = Array.isArray(card.fees) ? card.fees : [];
        const lines = Array.isArray(card.lines) ? card.lines : [];
        if (fees.length + lines.length === 0 || fees.length > QUOTE_ADD_MAX_FEES || lines.length > QUOTE_BUILD_MAX_LINES) return untouched("That isn't valid — ask again.");
        if (fees.some((fee) => !Number.isInteger(fee.amountCents) || fee.amountCents <= 0 || fee.amountCents > QUOTE_ADD_MAX_FEE_RANDS * 100 || !String(fee.label ?? "").trim())) {
          return untouched("That isn't valid — ask again.");
        }
        const quote = await prisma.quote.findFirst({ where: { id: String(card.quoteId ?? ""), deletedAt: null }, select: { id: true, status: true, contactId: true, leadId: true } });
        // Asked here as a yes/no: saveQuoteDraft's own check REDIRECTS, which a Confirm tapped on WhatsApp has nowhere to follow.
        if (!quote || !(await hasPermission(user, "quotes.edit")) || !(await canAccessQuote(user, quote.id))) return untouched("That quote is no longer there.");
        if (quote.status !== "draft" || !quote.contactId) return untouched("That quote is no longer a draft, so it can't be added to — revise it in the CRM.");
        const products = await prisma.product.findMany({
          where: { id: { in: [...new Set(lines.map((line) => String(line.productId)))] }, active: true, deletedAt: null },
          select: { id: true, name: true, basePriceCents: true },
        });
        const byId = new Map(products.map((product) => [product.id, product]));
        if (lines.some((line) => byId.get(line.productId)?.basePriceCents !== line.unitPriceCents)) {
          return untouched("The catalogue changed since DAX suggested this — ask again to see today's prices.");
        }
        const saved = await saveQuoteDraft({
          id: quote.id,
          contactId: quote.contactId,
          // Add-only: the quote's own expiry, terms, VAT mode and deposit are not sent and not touched.
          terms: "",
          intent: "draft",
          appendOnly: true,
          confirmKey: card.confirmKey,
          pdfToMyWhatsApp: true,
          items: lines.map((line) => {
            const product = byId.get(line.productId)!;
            return {
              description: product.name, qty: line.qty, unitPriceCents: product.basePriceCents, productId: product.id,
              discountPct: line.discountPct, ...(line.colour ? { colorPreference: line.colour } : {}),
            };
          }),
          fees: fees.map((fee) => ({ label: String(fee.label).trim(), kind: fee.delivery ? "delivery" as const : "fee" as const, amountCents: fee.amountCents })),
        });
        // Already carried out (the first Confirm's answer never reached them): said as done, and nothing is added again.
        if (!saved.ok && saved.repeated) return { ok: true, success: "Already added — nothing was added twice. It has NOT been sent to the customer.", href: `/quotes?edit=${quote.id}` };
        if (!saved.ok) return { ok: false, error: saved.error };
        await logAudit({
          action: "assistant.action_confirmed",
          summary: `Confirmed the assistant's proposal: add to draft quote Q-${saved.quote.number}`,
          user,
          ...(quote.leadId ? { leadId: quote.leadId } : { contactId: quote.contactId }),
        });
        await recordTaskProgress(user.id, card.taskId, { done: `Added to Q-${saved.quote.number}` });
        const after = await prisma.quote.findUnique({ where: { id: quote.id }, include: { items: true, fees: true } }).catch(() => null);
        const total = after ? formatZAR(Math.round(payableTotalCents(after))) : null;
        await sendQueuedPdfNow();
        return {
          ok: true,
          success: `Draft quote Q-${saved.quote.number} updated${total ? ` — now ${total}` : ""}. It has NOT been sent to the customer.`,
          href: `/quotes?edit=${quote.id}`,
          quote: { id: quote.id, number: saved.quote.number },
        };
      }
      default:
        return { ok: false, error: "Messages go out only with the Send button on their card." };
    }
  });
}

/**
 * Send a message DAX drafted — ONLY from the Send button on its card, after the
 * person has read it and, if they liked, changed it. The body is the person's
 * own (edited) text from the card, and it goes through the same action as the
 * lead's own message box: sendWhatsAppMessage (inbox.reply, the outbox, the
 * delivery log) or sendEmailAction (the workspace's mailbox, the signature,
 * the timeline). The recipient is read again here from the lead — never taken
 * from the browser — so an edited card can't redirect it.
 */
export async function sendAssistantDraft(input: { leadId: string; channel: "whatsapp" | "email"; subject?: string; body: string; compositionId: string }): Promise<{ ok: boolean; error?: string; success?: string }> {
  return withActingStaffScope(async () => {
    const user = await requireAnyPermission(...ASSISTANT_PERMISSIONS);
    if (!(await isModuleEnabled("automation"))) {
      return { ok: false, error: "Ask the CRM is part of the Automation & AI module, which is off for this workspace." };
    }
    const body = String(input?.body ?? "").trim().slice(0, 4000);
    if (!body) return { ok: false, error: "The message is empty." };
    if (!(await canAccessLead(user, String(input.leadId)))) return { ok: false, error: "That lead is no longer yours to message." };
    const lead = await prisma.lead.findUnique({
      where: { id: input.leadId },
      select: { email: true, phone: true, contactId: true, contact: { select: { email: true, phone: true } } },
    });
    if (!lead) return { ok: false, error: "That lead is no longer there." };
    const form = new FormData();
    form.set("leadId", input.leadId);
    if (lead.contactId) form.set("contactId", lead.contactId);
    let result: { ok?: string; error?: string };
    if (input.channel === "whatsapp") {
      const phone = lead.phone || lead.contact?.phone;
      if (!phone) return { ok: false, error: "There's no WhatsApp number on this lead or its customer." };
      form.set("phone", phone);
      form.set("text", body);
      form.set("compositionId", String(input.compositionId ?? "").slice(0, 80));
      result = await sendWhatsAppMessage(undefined, form);
    } else {
      const to = lead.email || lead.contact?.email;
      if (!to) return { ok: false, error: "There's no email address on this lead or its customer." };
      const subject = String(input.subject ?? "").trim().slice(0, 150);
      if (!subject) return { ok: false, error: "Add a subject first." };
      form.set("to", to);
      form.set("subject", subject);
      form.set("bodyHtml", body.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join(""));
      form.set("revalidate", `/leads/${input.leadId}`);
      result = await sendEmailAction(undefined, form);
    }
    if (result.error) return { ok: false, error: result.error };
    await logAudit({
      action: "assistant.draft_sent",
      summary: `Sent a ${input.channel === "whatsapp" ? "WhatsApp" : "email"} the assistant drafted, after reviewing it`,
      user,
      leadId: input.leadId,
    });
    return { ok: true, success: result.ok ?? "Sent" };
  });
}

/**
 * Is the record still as it was when DAX proposed the card? Only the field the
 * card changes (assistantActions STALE CARDS). Read through the tenant-scoped
 * client; the action that runs next checks access again in full.
 */
async function stillAsProposed(card: ActionCard): Promise<boolean> {
  switch (card.kind) {
    case "stage":
    case "assign":
    case "lost": {
      const lead = await prisma.lead.findUnique({ where: { id: card.leadId }, select: { stageId: true, assignedToId: true, status: true } });
      if (!lead || lead.status !== "open") return false;
      if (card.kind === "stage") return lead.stageId === card.fromStageId;
      if (card.kind === "assign") return lead.assignedToId === card.fromUserId;
      return true;
    }
    case "reschedule":
    case "cancel_activity": {
      const activity = await prisma.activity.findUnique({ where: { id: card.activityId }, select: { status: true, dueDate: true } });
      return Boolean(activity && activity.status === "planned" && activity.dueDate.toISOString() === card.fromDue);
    }
    default:
      return true;
  }
}

const escapeHtml =(s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Confirm a card that was SAVED for the CRM — a task the assistant proposed on
 * WhatsApp that is only done here (assistantWhatsAppConfirm.ts, `forCrm`).
 *
 * The card that runs is the one in the database, found by the signed-in
 * person's own id: nothing the page sends is trusted but which row. And it runs
 * AT MOST ONCE, by the same rule as a tap on WhatsApp — the claim is one
 * conditional update, so a double click, two tabs, or a reload after a dropped
 * connection cannot run it twice. Afterwards:
 *   done      → it is finished and leaves the list;
 *   unchanged → the action proved it wrote nothing (out of date, lead gone):
 *               the claim is released, and it can be confirmed again;
 *   anything else, or a throw → how far it got is unknown: marked failed, and
 *               never retried. Retrying an unknown is how a note is written twice.
 */
export async function confirmSavedAssistantCard(savedId: string): Promise<{ ok: boolean; error?: string; success?: string; href?: string; unchanged?: boolean }> {
  return withActingStaffScope(async () => {
    const user = await requireAnyPermission(...ASSISTANT_PERMISSIONS);
    const id = String(savedId ?? "");
    const now = new Date();
    const claimed = await prisma.assistantPendingAction.updateMany({
      where: { id, userId: user.id, forCrm: true, confirmedAt: null, completedAt: null, failedAt: null, expiresAt: { gt: now } },
      data: { confirmedAt: now },
    });
    if (claimed.count !== 1) return { ok: false, error: "That card is no longer waiting — it was already confirmed or dismissed, or it has expired. Ask again if you still want it." };
    // Guarded on THIS claim, so nothing a later attempt did is undone by this one finishing.
    const settle = (data: { completedAt?: Date; failedAt?: Date; confirmedAt?: null }) =>
      prisma.assistantPendingAction.updateMany({ where: { id, userId: user.id, forCrm: true, confirmedAt: now, completedAt: null, failedAt: null }, data });
    const saved = await prisma.assistantPendingAction.findFirst({ where: { id, userId: user.id, forCrm: true }, select: { card: true } });
    const card = saved?.card as ActionCard | undefined;
    // A message to a customer is never sent by Confirm: it has its own Send, where the wording is read and can be changed.
    if (!card || typeof card.kind !== "string" || card.kind === "draft_message") {
      await settle({ failedAt: new Date() });
      return { ok: false, error: "That card can't be confirmed here." };
    }
    try {
      const result = await runAssistantAction(card);
      if (result.ok) await settle({ completedAt: new Date() });
      // `resumable`: part was written, and confirming again finds it rather than writing it twice.
      else if (result.unchanged === true || result.resumable === true) await settle({ confirmedAt: null });
      else await settle({ failedAt: new Date() });
      // The page is NOT refreshed here. The card on screen shows what happened —
      // done, with its link, or why it failed — and a refresh would remove it
      // (it is no longer waiting) before the person had read that. It is gone
      // the next time the page loads.
      return result.ok || result.unchanged === true || result.resumable === true
        ? result
        : { ok: false, error: `${result.error ?? "That didn't work."} It won't be tried again from this card, because I can't be sure nothing was changed — check the record, then ask again if it's still needed.` };
    } catch (error) {
      await settle({ failedAt: new Date() });
      throw error;
    }
  });
}

/**
 * A saved card is finished with, without Confirm: dismissed (removed), or its
 * drafted message was sent (kept as done until it is pruned). The person's own
 * card only — the row is named by their id.
 */
export async function settleSavedAssistantCard(savedId: string, outcome: "sent" | "dismissed"): Promise<{ ok: boolean }> {
  return withActingStaffScope(async () => {
    const user = await requireAnyPermission(...ASSISTANT_PERMISSIONS);
    const id = String(savedId ?? "");
    const changed =
      outcome === "dismissed"
        ? // confirmedAt: null — NOT WHILE IT IS RUNNING. Confirm claims the card by
          // setting confirmedAt; a dismissal that could delete a claimed row made
          // the card vanish while its action went on and completed. A claim is
          // released (set back to null) only when the action proved it wrote nothing.
          await prisma.assistantPendingAction.deleteMany({ where: { id, userId: user.id, forCrm: true, confirmedAt: null, completedAt: null } })
        : outcome === "sent"
          ? await prisma.assistantPendingAction.updateMany({ where: { id, userId: user.id, forCrm: true, completedAt: null }, data: { completedAt: new Date() } })
          : { count: 0 };
    // No refresh, for the same reason as above: a sent card stays on screen saying "Sent".
    return { ok: changed.count === 1 };
  });
}

/**
 * 👍 / 👎 on one of the person's OWN answers, with a reason when it was wrong —
 * kept on the turn for the owner to read (Settings → Assistant), never sent
 * anywhere. Their own turns only: the update names the user.
 */
const FEEDBACK_REASONS = ["wrong_facts", "bad_advice", "misunderstood", "other"] as const;
export async function rateAssistantAnswer(turnId: string, rating: "up" | "down", reason?: string): Promise<{ ok: boolean }> {
  return withActingStaffScope(async () => {
    const user = await requireAnyPermission(...ASSISTANT_PERMISSIONS);
    if (rating !== "up" && rating !== "down") return { ok: false };
    const why = rating === "down" && FEEDBACK_REASONS.includes(reason as (typeof FEEDBACK_REASONS)[number]) ? reason! : null;
    const updated = await prisma.assistantTurn.updateMany({
      where: { id: String(turnId), userId: user.id },
      data: { feedback: rating, feedbackReason: why, feedbackAt: new Date() },
    });
    return { ok: updated.count === 1 };
  });
}

/**
 * What the floating bubble needs when it opens: its name, and TODAY's
 * conversation only. Opening it is seeing it: this person's scheduled answers
 * are marked seen, so the unread dot goes on the next page.
 */
export async function openAssistantBubble(): Promise<
  { ok: true; name: string; connected: boolean; listen: boolean; history: { question: string; answer: string; source: string }[] } | { ok: false }
> {
  return withActingStaffScope(async () => {
    const user = await requireAnyPermission(...ASSISTANT_PERMISSIONS);
    if (!(await isModuleEnabled("automation"))) return { ok: false };
    const [profile, connected, history, , listen] = await Promise.all([
      getSetting(ASSISTANT_PROFILE_KEY).then(parseProfile),
      isCodexConnected(),
      assistantTurnsToday(user.id),
      markScheduledTurnsSeen(user.id),
      assistantVoiceRepliesOn().catch(() => false),
    ]);
    return { ok: true, name: profile.name, connected, listen, history };
  });
}

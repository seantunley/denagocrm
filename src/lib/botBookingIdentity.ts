/**
 * Who the chatbot is allowed to act for, when the action touches an existing
 * booking.
 *
 * This is deliberately a separate, import-free module: the rule it states is a
 * security boundary, and it should be executable by a test rather than inferred
 * from a pattern in a larger file that also talks to the database.
 */
export type BotBookingMatch = {
  contactId: string | null;
  leadId: string | null;
  /**
   * The channel lookup matched MORE THAN ONE record. Set by resolvers that can
   * tell; absent means "not known to be ambiguous", which is how the Messenger and
   * Instagram PSID lookups behave — a PSID names one person by construction.
   */
  ambiguous?: boolean;
};

/**
 * The owner of a booking, or null when we cannot prove who we are talking to.
 *
 * Identity must come from the CHANNEL, where the provider has already
 * authenticated the sender — `matchByPhone` on WhatsApp, the PSID→Contact lookup
 * on Messenger/Instagram.
 *
 * It used to fall back to a Contact lookup on the phone number the customer
 * TYPED into the chat. A typed number is a claim, not proof. On Telegram the
 * runner passes `{contactId: null, leadId: null}` unconditionally, so the typed
 * number was the ONLY thing between a stranger and someone else's booking: read
 * the time back, then move or cancel it. WhatsApp and Messenger had the same
 * hole for any sender not already in the CRM. Knowing a phone number is not the
 * same as controlling it.
 *
 * When the channel cannot say who this is, the honest answer is to hand the
 * conversation to a person. Restoring self-service on an unlinked channel needs
 * PROOF OF CONTROL — a one-time code sent to the number and quoted back — not a
 * softer lookup.
 */
export function channelVerifiedOwner(match: BotBookingMatch): BotBookingMatch | null {
  // Two records answering to one number is not proof of one person. The lookup can
  // still pick a stable row for filing the message — an inbound message has to go
  // somewhere — but acting on a booking needs to know WHOSE it is, and here it
  // does not. Same answer as an unlinked channel: hand it to a person.
  if (match.ambiguous) return null;
  return match.contactId || match.leadId ? match : null;
}

/**
 * Mark the conversation as unidentified and drop anything a previous turn had
 * resolved, so a later node cannot act on a booking id this customer was never
 * shown to own.
 */
export function markUnverified(vars: Record<string, string>): void {
  vars.booking_identity = "unverified";
  delete vars.booking_id;
  delete vars.booking_slot;
  delete vars.booking_summary;
}

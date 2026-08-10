/**
 * What a completed turn leaves behind for the next one.
 *
 * `botOwnership.decideInboundAct` answers the inbound half — what a customer
 * message is allowed to do to a conversation. This answers the outbound half:
 * after the engine has run, is the conversation still the bot's, has it been
 * handed to a person, or is it over?
 *
 * It exists as its own import-free module because the two runners
 * (`flowSession.advanceFlow` for Messenger/Instagram/Telegram and
 * `flowRun.runWhatsAppFlow` for WhatsApp) each wrote this three-way branch out by
 * hand, and each got it subtly wrong in the same way. The waiting branch stored
 * `result.session.vars` — the variables as the turn left them — while the handoff
 * branch stored the variables the turn STARTED with. `runFlow` deliberately works
 * on a copy of the caller's vars, so those two are not the same object and never
 * were: everything the final turn produced was silently dropped on handoff. The
 * capture the customer had just answered, `booking_id` / `booking_slot` written by
 * a CRM action, `journey_run_id`, and the `__handoff_*` context — none of it
 * reached the person taking the conversation over.
 *
 * Making the vars come from ONE place, for every outcome, is what stops that
 * class of bug rather than the two instances of it.
 */

/** Structurally compatible with `FlowResult`, without importing the engine. */
export type CompletedTurn = {
  session: { nodeId: string | null; vars: Record<string, string> } | null;
  handedOff: boolean;
  /** The variables as they stand at the END of the turn, on every path. */
  vars: Record<string, string>;
};

export type SessionAfterTurn =
  | {
      keep: true;
      nodeId: string | null;
      vars: Record<string, string>;
      status: "active" | "paused";
      /** "bot" while the bot is waiting; "ai_handoff" once it has handed over. */
      ownership: "bot" | "ai_handoff";
    }
  /** Nothing to resume from — the stored session is deleted. */
  | { keep: false };

export function sessionAfterTurn(result: CompletedTurn): SessionAfterTurn {
  // Waiting for the customer. The stored position is the node the engine stopped
  // on, and the variables are the ones this turn produced.
  if (result.session) {
    return { keep: true, nodeId: result.session.nodeId, vars: result.vars, status: "active", ownership: "bot" };
  }

  // The BOT handed off. A person has not taken this yet, so an explicit
  // "menu"/"restart" may still bring the customer back — but a greeting may not.
  //
  // There is no graph position to resume (the run is over), but the variables
  // still matter: they are what the person picking this up is shown, and what a
  // deliberate "menu" restart reads back. Storing the pre-turn vars here is
  // exactly the defect this module exists to prevent, so they come from
  // `result.vars` like every other outcome.
  if (result.handedOff) {
    return { keep: true, nodeId: null, vars: result.vars, status: "paused", ownership: "ai_handoff" };
  }

  return { keep: false };
}

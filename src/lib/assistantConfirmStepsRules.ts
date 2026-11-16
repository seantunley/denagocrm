/**
 * What a step-by-step Confirm card did (assistantConfirmSteps), in plain words — the SAME words on the web and on
 * WhatsApp, because both read runAssistantAction's result. Pure: no database.
 *
 * A step answers one of three things:
 *  - `done`: it happened — what to tell the person;
 *  - `refused`: the door it hands to turned it down (permission, validation), and running it again is safe — after a
 *    done step, Confirm can try it again; as the first step, it is the card's answer;
 *  - `unsure`: it may have written part of its work (an upload that errored after saving) — never run again, and said.
 * A step that THROWS is an infrastructure error: run again on the next Confirm.
 */
export type StepResult = { done: string } | { refused: string } | { unsure: string };

export type ConfirmOutcome =
  /** Every step done, some on this Confirm. */
  | { kind: "saved"; done: string[] }
  /** Every step was done by an earlier Confirm: nothing ran. */
  | { kind: "already"; done: string[] }
  /** Some done, one not: `retry` — refused, so Confirm again runs it (the done ones are not repeated); else unsure, final. */
  | { kind: "partly"; done: string[]; notDone: { label: string; why: string; retry: boolean } }
  /** A step threw: logged, its claim released. Confirm again carries on from it. */
  | { kind: "retry"; done: string[]; failed: string }
  /** Another Confirm of this card holds a step right now. */
  | { kind: "busy"; done: string[] }
  /** The first step was refused by the door it hands to. */
  | { kind: "refused"; why: string };

/** runAssistantAction's result shape — the one every Confirm door (web card, saved card, WhatsApp) already reads. */
export type ConfirmReply = { ok: boolean; success?: string; error?: string; resumable?: true };

const sentences = (parts: string[]) => parts.map((p) => p.trim().replace(/[.\s]+$/, "")).filter(Boolean).map((p) => `${p}.`).join(" ");

export function confirmReply(outcome: ConfirmOutcome): ConfirmReply {
  const done = "done" in outcome ? sentences(outcome.done) : "";
  const lead = done ? `${done} ` : "";
  switch (outcome.kind) {
    case "saved":
      return { ok: true, success: done || "Done." };
    case "already":
      return { ok: true, success: `Already done — nothing was done twice. ${done}`.trim() };
    case "partly": {
      const { label, why, retry } = outcome.notDone;
      const missing = `Not done: ${label} — ${why.trim().replace(/[.\s]+$/, "")}.`;
      if (retry) return { ok: false, resumable: true, error: `${lead}${missing} Confirm again to finish — what's done won't be repeated.` };
      // Unsure and final. Something done: the card is finished (said as it is); nothing done: a failure, not retried.
      return outcome.done.length ? { ok: true, success: `${lead}${missing}` } : { ok: false, error: missing };
    }
    case "retry":
      return { ok: false, resumable: true, error: `${lead}Couldn't finish ${outcome.failed} just now. Confirm again to carry on — what's done won't be repeated.` };
    case "busy":
      return { ok: false, resumable: true, error: `${lead}This is being saved right now — give it a moment. If it seems stuck, Confirm again in a few minutes.` };
    // The CRM's own door turned it down. Unproven that it wrote nothing (the house rule, runAssistantAction's
    // `untouched`): a plain failure — never "nothing was changed", never offered as a retry.
    case "refused":
      return { ok: false, error: outcome.why };
  }
}

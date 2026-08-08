import { randomBytes } from "node:crypto";

/**
 * How an action failure becomes a sentence — the part with no server in it.
 *
 * Split out from actionResult.ts because that module is `server-only`, which
 * cannot be imported outside Next's bundler. Everything about the rules below
 * was therefore tested by matching source text, and a rule tested that way is
 * pinned rather than checked: it will happily pass while the sentence it
 * produces leaks a connection string. Here they are ordinary functions that a
 * test can call.
 */

/** A refusal whose message is intended for the person who triggered the action. */
export class ActionRefusal extends Error {
  readonly userFacing = true;
  constructor(message: string) {
    super(message);
    this.name = "ActionRefusal";
  }
}

/**
 * The caller is not signed in, or no longer is.
 *
 * Separate from ActionRefusal because the remedy differs in kind: a refusal means
 * "change what you typed", this means "sign in again", and "try again" — which is
 * what the generic failure advised — cannot work. Not a refusal subclass because
 * the message shown is OURS: a guard's wording is written for a log, not a person.
 */
export class NotAuthenticated extends Error {
  constructor(message = "Not authenticated") {
    super(message);
    this.name = "NotAuthenticated";
  }
}

export const NOT_AUTHENTICATED_MESSAGE = "Your session has ended. Sign in again and retry.";

/**
 * Characters a reference may contain.
 *
 * Ambiguous ones are excluded on purpose: this gets read off a screen, typed into
 * a message, or said out loud, and `0`/`O` and `1`/`I` are where that goes wrong.
 * Vowels are excluded too, so a reference cannot come out as a word.
 */
export const REFERENCE_ALPHABET = "23456789CDFGHJKLMNPQRSTVWXYZ";

export const REFERENCE_LENGTH = 6;

/** A short handle tying the sentence someone SEES to the error we LOGGED. */
export function failureReference(): string {
  const bytes = randomBytes(REFERENCE_LENGTH);
  // Modulo bias is irrelevant: this is a log correlation handle, not a secret. It
  // needs to be unlikely to collide within a day of logs, not unguessable.
  return Array.from(bytes, (byte) => REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length]).join("");
}

export type Failure =
  /** Show the message verbatim. Nothing is logged; this is not a fault. */
  | { kind: "refusal"; message: string }
  /** Show our own wording. Nothing is logged; a signed-out caller is not a bug. */
  | { kind: "signed-out"; message: string }
  /** Log `logLine` server-side, show `message`. The two share a reference. */
  | { kind: "unexpected"; message: string; logLine: string };

/**
 * Decide what to say, and what to log, for one failed action.
 *
 * The reference is passed in rather than generated here so a caller — and a test
 * — can see that the SAME value reaches both the log line and the message. That
 * is the whole point of it: generating one internally for each would produce two
 * references that correlate nothing.
 */
export function classifyFailure(error: unknown, ref: string): Failure {
  if (error instanceof ActionRefusal) return { kind: "refusal", message: error.message };
  if (error instanceof NotAuthenticated) {
    return { kind: "signed-out", message: NOT_AUTHENTICATED_MESSAGE };
  }
  return {
    kind: "unexpected",
    // The reference goes FIRST so the line is found by searching for exactly what
    // the person quotes.
    logLine: `[action-failure ${ref}]`,
    // NOTHING from the error is interpolated. A Postgres error carries table and
    // column names; a fetch failure carries hosts and ports; a driver error can
    // carry the connection string. The detail belongs in the log, which is why
    // there is a reference to find it by.
    //
    // AND IT MUST NOT CLAIM THE WRITE WAS ROLLED BACK. This said "nothing was
    // saved", which is a promise about database state that this function is in no
    // position to make: most actions are several steps and only some are wrapped
    // in a transaction. markWon creates the contact, updates the lead, queues
    // journey work, writes the audit row and triggers a survey — a throw at step
    // four leaves the first three committed. Telling the salesperson nothing
    // happened invites the retry that duplicates them, which is exactly how the
    // duplicate leads got made on 2026-08-07.
    //
    // So the wording is state-NEUTRAL, and points at the one thing that is always
    // safe: look before you retry.
    message: `The operation did not complete cleanly. Check the record before retrying. Reference ${ref}.`,
  };
}

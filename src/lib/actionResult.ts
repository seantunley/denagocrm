import "server-only";
import { unstable_rethrow } from "next/navigation";

/**
 * Expected refusals travel as VALUES, never as thrown errors.
 *
 * Next.js does not send a thrown server-action error's message to the browser in
 * production. It replaces it with an opaque digest, so a carefully written
 * refusal — "That user already belongs to another tenant", "Cannot remove the
 * tenant owner" — arrives on the client as something like `aBc123` and can only
 * be rendered as a generic apology. Every guard message in the platform console
 * was in exactly that position: correct, specific, and invisible where it
 * mattered. Next's own guidance is to return expected errors as values and
 * reserve throwing for genuinely unexpected failures.
 *
 * Usage:
 *
 *   export async function doThing(formData: FormData): Promise<ActionResult> {
 *     return asActionResult(async () => {
 *       if (!name) refuse("Name is required.");
 *       ...
 *     });
 *   }
 *
 * `refuse()` marks a message as SAFE TO SHOW. Anything else that escapes is
 * unexpected — a bug, a database outage — and is logged with a reference rather
 * than shown, so the caller gets something quotable instead of internals.
 */

export type { ActionResult } from "./actionResultTypes";
import type { ActionResult } from "./actionResultTypes";
import { ActionRefusal, classifyFailure, failureReference, NotAuthenticated } from "./actionFailure";

// Re-exported so the many callers that import these from here keep working, and
// so there is one obvious place to import them from in an action.
export { ActionRefusal, NotAuthenticated };

/** Refuse with a message the caller may display verbatim. */
export function refuse(message: string): never {
  throw new ActionRefusal(message);
}

/**
 * Run an action body, converting refusals into `{ error }`.
 *
 * Next's control-flow throws for `redirect()` and `notFound()` are successful
 * outcomes and must keep propagating for the navigation to happen. That is what
 * `unstable_rethrow` is for, and it is used instead of matching digest strings
 * because those markers change between versions — a stale matcher here would
 * swallow a redirect and report a save that never happened.
 *
 * EVERYTHING ELSE IS LOGGED AND NAMED, rather than rethrown.
 *
 * Rethrowing was the original design, on the reasoning that an unexpected error
 * belongs in the logs and not on the screen. Half of that was right. What it
 * produced in practice was "Something went wrong. Please try again." — a sentence
 * that cannot distinguish a database outage from an expired session from a browser
 * tab older than the running deployment, gives nobody anything to quote, and whose
 * one piece of advice is wrong for two of those three. An afternoon went into a
 * tenant logo that would not save; the cause was a stale tab, and the message had
 * said nothing either way.
 *
 * The detail still never reaches the browser — a Postgres error names tables and
 * columns, a driver error can carry the connection string — but it is logged HERE
 * with a reference, and the same reference goes in the sentence.
 */
export async function asActionResult(
  body: () => Promise<void | ActionResult>,
): Promise<ActionResult> {
  try {
    // A body may return `{ success }` to describe what actually happened — for an
    // idempotent no-op like "left blank, kept the saved value", reporting the
    // form's generic "Saved" would claim a change that never occurred.
    return (await body()) ?? {};
  } catch (error) {
    // BEFORE anything else: a redirect is not a failure, and logging one as a
    // failure would fill the log with successful navigations.
    unstable_rethrow(error);

    const failure = classifyFailure(error, failureReference());
    // console.error, because that is what reaches the platform's runtime logs.
    if (failure.kind === "unexpected") console.error(failure.logLine, error);
    return { error: failure.message };
  }
}

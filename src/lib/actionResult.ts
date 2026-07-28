import "server-only";

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
 * unexpected — a bug, a database outage — and is rethrown so it reaches the error
 * boundary and the logs, and so the caller shows a generic message rather than
 * leaking internals.
 */

export type { ActionResult } from "./actionResultTypes";
import type { ActionResult } from "./actionResultTypes";

/** A refusal whose message is intended for the person who triggered the action. */
export class ActionRefusal extends Error {
  readonly userFacing = true;
  constructor(message: string) {
    super(message);
    this.name = "ActionRefusal";
  }
}

/** Refuse with a message the caller may display verbatim. */
export function refuse(message: string): never {
  throw new ActionRefusal(message);
}

/**
 * Run an action body, converting refusals into `{ error }`.
 *
 * Anything that is NOT an ActionRefusal is rethrown untouched. That deliberately
 * includes Next's control-flow throws for `redirect()` and `notFound()`, which are
 * successful outcomes and must keep propagating for the navigation to happen.
 */
export async function asActionResult(
  body: () => Promise<void>,
): Promise<ActionResult> {
  try {
    await body();
    return {};
  } catch (error) {
    if (error instanceof ActionRefusal) return { error: error.message };
    throw error;
  }
}

// Post-response work that a serverless invocation cannot silently drop.
//
// The pattern this replaces is `void (async () => { … })()`: the work is started
// and then nobody holds a reference to it, so on Vercel the invocation can be
// frozen or torn down the moment the response is flushed and the pending
// database write simply never happens. It fails invisibly — no error, no log,
// no row — and it fails MOST often for short handlers, which is precisely the
// shape of a "send a message" request.
//
// Next 16 ships the supported answer: `after()` (next/server), stable since
// 15.1. It hands the callback to the platform's `waitUntil`, which EXTENDS the
// invocation's lifetime until the promise settles, so the work runs after the
// response is sent but is still guaranteed to run. See
// node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md.
//
// `after()` only exists inside a request/prerender scope. Cron sweeps, scripts
// and unit tests have none, and it throws there — so this falls back to simply
// AWAITING the work, which is the other correct answer and is what those
// contexts want anyway (nothing is racing a response).

/** `after(task)` as we use it: a callback form, never a bare promise. */
type AfterFn = (task: () => Promise<void>) => void;

// `undefined` = not looked up yet, `null` = unavailable in this runtime.
let cachedAfter: AfterFn | null | undefined;

async function loadAfter(): Promise<AfterFn | null> {
  if (cachedAfter !== undefined) return cachedAfter;
  try {
    const mod = await import("next/server");
    cachedAfter = typeof mod.after === "function" ? (mod.after as AfterFn) : null;
  } catch {
    cachedAfter = null;
  }
  return cachedAfter;
}

/**
 * Runs `work` after the response, or awaits it when there is no response to run
 * after. Either way the work is REGISTERED with something that will see it
 * through — it is never left dangling.
 *
 * Swallows everything `work` throws. Callers use this for bookkeeping hanging
 * off a customer-facing action, and a failed write of telemetry must never
 * change the result of the thing it is telemetry about.
 *
 * Returns as soon as the work is registered (request scope) or finished (no
 * request scope), so `await`ing it is safe on a latency-sensitive path.
 *
 * `after()` binds the callback to the current execution context — Next's
 * AfterContext calls `bindSnapshot`, preserving every AsyncLocalStorage in
 * scope — so a tenant scope established for the request is still in place when
 * the callback runs. `deps` is injectable for unit tests only.
 */
export async function runAfterResponse(
  work: () => Promise<void>,
  deps: { after?: AfterFn | null } = {},
): Promise<void> {
  const guarded = async () => {
    try {
      await work();
    } catch {
      /* post-response bookkeeping must never surface as an error */
    }
  };

  const schedule = deps.after !== undefined ? deps.after : await loadAfter();
  if (schedule) {
    try {
      schedule(guarded);
      return;
    } catch {
      // No request scope (cron, script, test) or no waitUntil in this runtime —
      // fall through and await instead of losing the work.
    }
  }
  await guarded();
}

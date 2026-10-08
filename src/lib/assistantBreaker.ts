/**
 * DAX when ChatGPT is having a bad few minutes.
 *
 * RETRY ONCE, INSIDE THE SAME RUN. A 5xx or a dropped connection to ChatGPT is
 * usually gone a second later, so one retry after a short pause saves the
 * person a failed answer. Never for 429 (the plan's usage limit — it lifts on
 * its own, not in a second) and never more than once: the person is waiting.
 * It is the same question being answered, never a second request from them.
 *
 * THE BREAKER. If ChatGPT has failed again and again in the last few minutes,
 * making every question wait out another 45-second failure helps nobody. The
 * breaker opens for a short while: DAX answers what it can straight from the
 * CRM (the fast-path lookups, shown as rows, with a line saying the write-up is
 * unavailable) or says at once that ChatGPT is unreachable. One success closes
 * it again.
 *
 * ponytail: the breaker lives in this server instance's memory, so each
 * serverless instance learns about an outage on its own (a few failures
 * each). Fine for a handful of instances; move the counts into the database if
 * outages ever need to be shared instantly.
 */

export const BREAKER_FAILURES = 3;
export const BREAKER_WINDOW_MS = 2 * 60 * 1000;
export const BREAKER_OPEN_MS = 3 * 60 * 1000;
export const RETRY_PAUSE_MS = 1500;

type State = { failures: number[]; openUntil: number };
const byWorkspace = new Map<string, State>();
const stateOf = (key: string) => {
  let s = byWorkspace.get(key);
  if (!s) byWorkspace.set(key, (s = { failures: [], openUntil: 0 }));
  return s;
};

/** Is DAX in degraded mode for this workspace right now? */
export function breakerOpen(key: string, now: number = Date.now()): boolean {
  return stateOf(key).openUntil > now;
}

export function recordFailure(key: string, now: number = Date.now()): void {
  const s = stateOf(key);
  s.failures = [...s.failures.filter((t) => now - t < BREAKER_WINDOW_MS), now];
  if (s.failures.length >= BREAKER_FAILURES) {
    s.openUntil = now + BREAKER_OPEN_MS;
    s.failures = [];
  }
}

export function recordSuccess(key: string): void {
  const s = stateOf(key);
  s.failures = [];
  s.openUntil = 0;
}

/** Worth one more try? Transient, and not the usage limit. */
export function retryable(result: { error?: string; transient?: boolean }): boolean {
  return Boolean(result.error && result.transient && !/\(429\)/.test(result.error));
}

/**
 * Call `once`; on a retryable failure wait a moment and call it once more.
 * Records the outcome for the breaker. `once` is given the attempt number so a
 * streaming caller can start its visible text afresh on the retry.
 */
export async function withRetry<T extends { error?: string; transient?: boolean } | object>(
  key: string,
  once: (attempt: number) => Promise<T>,
  pause: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  let result = await once(0);
  if ("error" in result && retryable(result as { error?: string; transient?: boolean })) {
    await pause(RETRY_PAUSE_MS);
    result = await once(1);
  }
  // Only an outage counts: a refused request or a missing connection is a
  // setting to fix, and degraded mode wouldn't help it.
  if (!("error" in result)) recordSuccess(key);
  else if ((result as { transient?: boolean }).transient) recordFailure(key);
  return result;
}

/** For tests: forget everything. */
export function resetBreaker(): void {
  byWorkspace.clear();
}

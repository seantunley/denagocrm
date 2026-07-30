/**
 * The one thing a long-running background job needs from its caller: permission
 * to keep going.
 *
 * This is deliberately the same shape as the cron slice context's `shouldStop`,
 * so a route can pass its budget straight through without adapting it — but it
 * is defined separately so the journey engine does not have to depend on the
 * cron runner, and so tests can drive it with a plain object.
 *
 * WHY IT EXISTS
 *
 * The journey engine can schedule up to 1000 records, process 50 events, and
 * process 40 runs of up to 20 steps each — sequentially, with no notion of time.
 * Admitting it with "probably enough" seconds left and hoping is not a bound: it
 * sends email and WhatsApp, so being killed partway through is a half-delivered
 * campaign, not a retryable no-op. It has to be able to stop between units.
 */
export type StopSignal = {
  /**
   * True when the caller wants the work to stop. `reserveMs` is how long the
   * NEXT unit of work is expected to need — asking with a reserve is what
   * prevents starting something that cannot finish.
   */
  shouldStop: (reserveMs?: number) => boolean;
};

/** For callers with no deadline at all — a user pressing "enrol now", a test. */
export const NEVER_STOP: StopSignal = { shouldStop: () => false };

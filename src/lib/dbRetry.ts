/**
 * Wakes the database before a cron sweep starts, and NOTHING else.
 *
 * Neon suspends idle compute behind a pooler, so the first query of a run can
 * land while the endpoint is still waking and fail outright:
 *
 *   Can't reach database server at `…-pooler….neon.tech:5432`   (Prisma P1001)
 *
 * That cost whole 15-minute slots of the automations cron: the error escaped
 * before any queue ran, so reminders, lead sync and review sync simply did not
 * happen until the next tick.
 *
 * WHY A PREFLIGHT AND NOT A RETRY AROUND THE SWEEP
 *
 * The obvious fix — retry the sweep — is wrong, and dangerously so:
 *
 *   - The sweep SENDS THINGS. Emails, pushes, WhatsApp messages, queue work. A
 *     connection fault partway through would replay everything already done.
 *     Re-sending a customer's reminder is far worse than skipping one slot.
 *   - It would not even work where it was most needed: runCronPerTenant catches
 *     per-tenant failures internally and reports them, so an outer retry never
 *     sees them. Unsafe in one mode, ineffective in the other.
 *   - A retry can only be time-bounded if you know what an attempt costs. A
 *     sweep costs up to its whole budget (45s, or 270s for competitor-watch),
 *     so "is there time for another attempt?" is unanswerable late in the run —
 *     and getting it wrong means the platform kills the function MID-WRITE.
 *
 * `SELECT 1` has none of those problems. It sends nothing, costs milliseconds,
 * and is safe to repeat. Warm the connection, then run the sweep exactly once.
 */

/**
 * Prisma's connection-level codes: unreachable, TLS failure, connection closed.
 * These are structural — an email or HTTP client cannot produce them.
 */
const TRANSIENT_CODES = new Set(["P1001", "P1002", "P1017"]);

/**
 * Text fallback for the same faults when the code is missing.
 *
 * DELIBERATELY NARROW. An earlier version matched bare "connection reset" and
 * "ECONNRESET", which any email, HTTP or AI provider can raise — and the cron
 * calls all three, so a provider hiccup would have been classified as a
 * database fault. Every phrase below names the database or the Prisma pool.
 */
const TRANSIENT_TEXT = [
  "can't reach database server",
  "cannot reach database server",
  "server has closed the connection",
  "timed out fetching a new connection from the connection pool",
  "error querying the database",
];

export function isTransientDbError(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  if (code && TRANSIENT_CODES.has(code)) return true;
  const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  return TRANSIENT_TEXT.some((needle) => message.includes(needle));
}

export type WarmUpOptions = {
  /** Total attempts, including the first. */
  attempts?: number;
  /** Base backoff; doubles each attempt. Enough to outlast a cold start. */
  baseDelayMs?: number;
  /** Called before each retry — for logging, never for control flow. */
  onRetry?: (attempt: number, error: unknown) => void;
  /** Injectable sleep, so tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Absolute epoch-ms ceiling for the warm-up. A connection attempt does not
   * fail instantly — a P1002 TLS timeout can hang for many seconds — so three
   * attempts plus backoff could otherwise eat most of the route's wall clock
   * before the sweep even starts, leaving it to be killed mid-write.
   */
  deadlineAt?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
};

/**
 * Runs `ping` until it answers, retrying only genuinely transient connection
 * faults. Anything else — a bad credential, a missing database — propagates on
 * the first attempt, because repeating it neither helps nor is safe.
 *
 * Returns true when the database answered. Returns FALSE rather than throwing
 * when every attempt hit a transient fault: a cold database is an operational
 * condition, and the caller decides what to do about it.
 */
export async function warmUpDatabase(
  ping: () => Promise<unknown>,
  options: WarmUpOptions = {},
): Promise<boolean> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => Date.now());

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await ping();
      return true;
    } catch (error) {
      if (!isTransientDbError(error)) throw error;
      if (attempt === attempts) return false;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      // Out of warm-up time: give the remaining budget to the sweep rather than
      // spending it on another ping.
      if (options.deadlineAt !== undefined && now() + delay >= options.deadlineAt) return false;
      options.onRetry?.(attempt, error);
      await sleep(delay);
    }
  }
  return false;
}

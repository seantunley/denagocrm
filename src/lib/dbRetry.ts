/**
 * Retries work that failed only because the database was briefly unreachable.
 *
 * Neon suspends idle compute and fronts it with a pooler, so the FIRST query of
 * a run can land while the endpoint is still waking and fail outright:
 *
 *   Can't reach database server at `…-pooler….neon.tech:5432`   (Prisma P1001)
 *
 * In a request that is fine — the person retries. In a cron it is not: the whole
 * 15-minute slot is lost, and the queues it drives (reminders, lead sync, review
 * sync) simply do not run until the next one. It cost three whole runs over two
 * days, always on the first query of the handler.
 *
 * Only genuinely transient CONNECTION faults are retried. A constraint
 * violation, a bad query or an application error is not retried and not
 * swallowed — it propagates on the first attempt exactly as before, because
 * repeating those neither helps nor is safe.
 */

/** Prisma's connection-level codes: unreachable, TLS failure, connection closed. */
const TRANSIENT_CODES = new Set(["P1001", "P1002", "P1017"]);

/** Postgres/driver text seen when the pooler drops or refuses a connection. */
const TRANSIENT_TEXT = [
  "can't reach database server",
  "connection closed",
  "connection reset",
  "server has closed the connection",
  "timed out fetching a new connection",
  "econnrefused",
  "econnreset",
];

export function isTransientDbError(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  if (code && TRANSIENT_CODES.has(code)) return true;
  const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  return TRANSIENT_TEXT.some((needle) => message.includes(needle));
}

export type DbRetryOptions = {
  /** Total attempts, including the first. */
  attempts?: number;
  /** Base backoff; doubles each attempt. Generous enough to outlast a cold start. */
  baseDelayMs?: number;
  /** Called before each retry — for logging, never for control flow. */
  onRetry?: (attempt: number, error: unknown) => void;
  /** Injectable sleep, so tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Absolute epoch-ms ceiling for the whole thing. Cron handlers have a hard
   * platform timeout, and a run that failed transiently 40 seconds in must NOT
   * be retried into a timeout — a clean error is far more useful than the
   * function being killed mid-write. When there is not enough time left for
   * another attempt, the original error is rethrown immediately.
   */
  deadlineAt?: number;
  /** Time an attempt is assumed to need; retries are skipped below this. */
  minAttemptMs?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
};

export async function withDbRetry<T>(run: () => Promise<T>, options: DbRetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelayMs = options.baseDelayMs ?? 1_500;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => Date.now());
  const minAttemptMs = options.minAttemptMs ?? 5_000;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await run();
    } catch (error) {
      // Not transient, or out of attempts: surface it untouched. This helper
      // exists to absorb a cold start, not to hide real failures.
      if (!isTransientDbError(error) || attempt === attempts) throw error;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      // No time for another go before the platform kills us — report honestly
      // rather than being terminated mid-attempt.
      if (options.deadlineAt !== undefined && now() + delay + minAttemptMs > options.deadlineAt) {
        throw error;
      }
      lastError = error;
      options.onRetry?.(attempt, error);
      await sleep(delay);
    }
  }
  throw lastError;
}

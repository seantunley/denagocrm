/**
 * Reconciling a provider's ASYNC delivery failure (WhatsApp `failed` status)
 * with the outbox row it is about — the same race, and the same two-sided
 * cleanup, as the Meta echo in ./metaEcho.ts.
 *
 * We only learn the provider id (wamid) from the response to our own send, and
 * Meta can dispatch the `failed` status before the worker has committed that id.
 * Matching only committed ids acked that early webhook against nothing, then
 * the worker wrote the row `sent` — "Sent ✓" for a message that never arrived.
 *
 * So an unmatched failure is PARKED durably, keyed by tenant + channel + id, and
 * whichever side commits second applies it:
 *
 *   worker                          webhook
 *   ──────                          ───────
 *   POST /messages → wamid.1
 *                                   failed(wamid.1): no row holds it
 *                                   → PARK it, re-check (still nothing)
 *   UPDATE … sent, providerMessageId
 *   reconcile: parked failure found
 *   → row dead, parked record consumed
 *
 * and the other order — the id is committed first, so the webhook marks the row
 * directly and parks nothing. In between (webhook misses, worker commits and
 * finds nothing parked, webhook parks), the webhook's own re-check after parking
 * applies it. No interleaving leaves the row `sent`.
 *
 * `markFailed` also matches a row already `dead` with that id, so a redelivered
 * webhook is an idempotent re-write, never a stray parked record.
 *
 * Pure over a small ledger interface, so the interleavings are testable without
 * a database; botOutbox.ts supplies the Prisma implementation.
 */

export type ProviderFailure = { providerMessageId: string; failureCode: string; detail: string };

export type FailureLedger = {
  /** Mark the outbox row holding this provider id (sent, or already dead) as dead. Rows matched. */
  markFailed(failure: ProviderFailure): Promise<number>;
  /** Durably keep a failure no row holds yet. Idempotent on the provider id. */
  park(failure: ProviderFailure): Promise<void>;
  /** The parked, not-yet-applied failure for this id. */
  parked(providerMessageId: string): Promise<ProviderFailure | null>;
  /** Mark the parked failure applied. */
  consume(providerMessageId: string): Promise<void>;
};

/** Webhook side: apply now, or park and re-check. Returns rows marked. */
export async function recordProviderFailure(ledger: FailureLedger, failure: ProviderFailure): Promise<number> {
  const marked = await ledger.markFailed(failure);
  if (marked > 0) return marked;
  await ledger.park(failure);
  // The worker may have committed the id between our miss and the park, and
  // already looked for a parked failure before there was one.
  return reconcileProviderFailure(ledger, failure.providerMessageId);
}

/** Worker side, right after committing the provider id. Returns rows marked. */
export async function reconcileProviderFailure(ledger: FailureLedger, providerMessageId: string): Promise<number> {
  const parked = await ledger.parked(providerMessageId);
  if (!parked) return 0;
  const marked = await ledger.markFailed(parked);
  if (marked > 0) await ledger.consume(providerMessageId);
  return marked;
}

/** The parked payload, as stored in a text column. */
export function encodeParkedFailure(failure: ProviderFailure): string {
  return JSON.stringify({ failureCode: failure.failureCode, detail: failure.detail });
}

export function decodeParkedFailure(providerMessageId: string, stored: string | null): ProviderFailure {
  try {
    const parsed = JSON.parse(stored ?? "") as { failureCode?: unknown; detail?: unknown };
    return {
      providerMessageId,
      failureCode: typeof parsed.failureCode === "string" ? parsed.failureCode : "provider_error",
      detail: typeof parsed.detail === "string" ? parsed.detail : "",
    };
  } catch {
    return { providerMessageId, failureCode: "provider_error", detail: "" };
  }
}

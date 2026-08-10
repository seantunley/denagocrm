/**
 * The retry decision for an inbound provider webhook, with no imports, so a test
 * can EXECUTE it rather than pattern-match the route's source — which is exactly
 * how the double-log below survived the first round of tests.
 *
 * "Please redeliver this" is a deliberate answer, and it has to look like one to
 * the provider AND to the operator. The signal was originally thrown outside the
 * surrounding try on all three webhooks, so it left the route as an unhandled
 * rejection. Catching it at the outer boundary fixed the status but not the
 * visibility: that boundary is outside `withChannelTenantScope`, so `logError`
 * found no scope, fell back to a staff session a webhook does not have, and filed
 * the row with `tenantId = null` — which the System Log and the platform Errors
 * tab both exclude. The row existed and the operator still could not see it.
 */

/**
 * Thrown to abort an inbound batch AFTER the reason has already been recorded,
 * inside the tenant scope that owns it. Carrying "already logged" in the type is
 * what keeps the throw site and the boundary from getting out of step.
 */
export class InboundRetryRequested extends Error {
  constructor(readonly kind: "leased" | "failed", detail: string) {
    super(`Inbound ${detail} could not be completed (${kind}) — asking the provider to redeliver`);
    this.name = "InboundRetryRequested";
  }
}

/** What to answer for an error escaping an inbound webhook. */
export function retryResponseFor(error: unknown): {
  status: number;
  retryAfterSeconds?: number;
  alreadyLogged: boolean;
} {
  if (error instanceof InboundRetryRequested) {
    // Leased is transient BY CONSTRUCTION — another attempt holds it and the lease
    // expires — so 503 + Retry-After is the accurate status, and the one least
    // likely to be counted against the subscription as a server fault.
    return error.kind === "leased"
      ? { status: 503, retryAfterSeconds: 10, alreadyLogged: true }
      : { status: 500, alreadyLogged: true };
  }
  // Something nobody expected. Not known to be transient, and nobody has logged it.
  return { status: 500, alreadyLogged: false };
}

/**
 * Whether raising this signal should file a row, and how.
 *
 * `null` for a "failed" signal: it is raised only where the message handler has
 * ALREADY logged the underlying error with its claim released. Logging again
 * would file the same failure twice, and once enforcement is on the second copy
 * is unattributed — so the two rows would not even agree on whose failure it was.
 *
 * `alert: false` on the leased case: a lease contention is the system working —
 * two attempts raced and one won — so it must never raise the first-error push.
 * That matters most while enforcement is dormant, when `sendPushToAll` has no
 * scope to narrow to and would notify every subscription on the install.
 */
export function retryLogPlan(
  kind: "leased" | "failed",
  tenantId?: string | null,
): { context: string; options: { alert: false; tenantId?: string | null } } | null {
  if (kind !== "leased") return null;
  return {
    context: "Deliberate redelivery request — the event is leased by another attempt.",
    // Deliberately omitted rather than passed as null when the caller does not
    // know: an explicit null tells logError "unattributed", not "infer one".
    options: { alert: false, ...(tenantId !== undefined ? { tenantId } : {}) },
  };
}

/**
 * The leased path, end to end: resolve the owning tenant, decide the log, and
 * produce the signal to throw.
 *
 * This exists because the previous version was correct at the helper and wrong at
 * the call site. `retryLogPlan` could carry a tenant, and the WhatsApp/Messenger
 * routes never passed one — so while enforcement is DORMANT, where
 * `withChannelTenantScope` runs `fn()` with no scope at all, the row still filed
 * with `tenantId = null` and the workspace's System Log still excluded it. The
 * property was tested on the helper, which the caller did not satisfy.
 *
 * The resolver is injected, so a test can run the actual composition — dormant
 * enforcement, an endpoint owned by tenant B, a leased event — rather than assert
 * that the helper works when handed an answer nobody gives it.
 *
 * Only the RARE leased branch pays for the lookup; the normal path never calls it.
 */
export async function planLeasedRetry(
  detail: string,
  resolveTenant: () => Promise<string | null>,
): Promise<{
  signal: InboundRetryRequested;
  log: { context: string; options: { alert: false; tenantId?: string | null } };
}> {
  // An unmapped endpoint genuinely has no owner. Pass undefined rather than null
  // so logError still tries to infer one from an enforced scope, instead of being
  // told the row is deliberately unattributed.
  const tenantId = (await resolveTenant().catch(() => null)) ?? undefined;
  return {
    signal: new InboundRetryRequested("leased", detail),
    log: retryLogPlan("leased", tenantId)!,
  };
}

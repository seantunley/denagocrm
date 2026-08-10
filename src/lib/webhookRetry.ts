import "server-only";
import { NextResponse } from "next/server";
import { logError } from "./errorLog";
import { InboundRetryRequested, planLeasedRetry, retryLogPlan, retryResponseFor } from "./inboundRetrySignal";
import { resolveChannelTenant, type ChannelKind } from "./channelTenant";

export { InboundRetryRequested, retryLogPlan, retryResponseFor };

/**
 * Raise a leased-event redelivery request, attributed to the tenant that owns the
 * provider endpoint it arrived on.
 *
 * `withChannelTenantScope` establishes NO scope while enforcement is dormant — it
 * is `if (!tenantEnforcing()) return fn();` — so being inside the wrapper is not
 * enough to know the owner today. The endpoint is, and `resolveChannelTenant`
 * already maps it. Only this rare branch pays for the lookup.
 */
export async function noteLeasedInbound(
  source: string,
  channel: ChannelKind,
  externalId: string | null | undefined,
  detail: string,
): Promise<InboundRetryRequested> {
  const { signal, log } = await planLeasedRetry(detail, () => resolveChannelTenant(channel, externalId));
  await logError(source, signal, log.context, log.options).catch(() => {});
  return signal;
}

/**
 * Record a deliberate redelivery request WHILE its owning tenant is still known,
 * and return the signal to throw.
 *
 * Called at the throw site, inside the tenant scope wrapper. Doing it at the
 * outer catch instead files the row unattributed, because the scope has already
 * unwound and a webhook has no staff session to fall back to.
 *
 * See {@link retryLogPlan} for why a "failed" signal records nothing here.
 */
export async function noteInboundRetry(
  source: string,
  kind: "leased" | "failed",
  detail: string,
  tenantId?: string | null,
): Promise<InboundRetryRequested> {
  const signal = new InboundRetryRequested(kind, detail);
  const plan = retryLogPlan(kind, tenantId);
  if (plan) await logError(source, signal, plan.context, plan.options).catch(() => {});
  return signal;
}

/**
 * Turn an escaping retry signal into the response the provider should see.
 *
 * The batch is deliberately NOT continued past one. Provider batches carry
 * consecutive messages from the same customer, so processing the siblings of a
 * message we could not finish would answer the customer's second question before
 * the first — and the redelivery replays the whole batch in order anyway,
 * skipping the ones the ledger has already completed.
 */
export async function inboundRetryResponse(source: string, error: unknown): Promise<NextResponse> {
  const { status, retryAfterSeconds, alreadyLogged } = retryResponseFor(error);
  if (!alreadyLogged) {
    await logError(source, error, "Inbound webhook batch aborted by an unexpected error.").catch(() => {});
  }
  return NextResponse.json(
    { error: "retry" },
    { status, ...(retryAfterSeconds ? { headers: { "Retry-After": String(retryAfterSeconds) } } : {}) },
  );
}

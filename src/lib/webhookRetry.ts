import "server-only";
import { NextResponse } from "next/server";
import { InboundBotEventLeasedError } from "./botInboundEvent";
import { logError } from "./errorLog";

/**
 * Answer a provider webhook with a DELIBERATE "send it again".
 *
 * `InboundBotEventLeasedError` is thrown to mean exactly that, but on all three
 * webhooks it was thrown OUTSIDE the surrounding try — so it left the route as an
 * unhandled rejection. The provider does redeliver, because any non-2xx makes it,
 * but everything else about that is wrong:
 *
 *   - nothing reaches ErrorLog, so the operator cannot see the redelivery loop at
 *     all, let alone that it is deliberate;
 *   - the platform records a crashed invocation, which is indistinguishable from
 *     a real fault when triaging;
 *   - the status is whatever the framework decides, and a run of unexplained 500s
 *     is what gets a Meta/WhatsApp subscription disabled.
 *
 * A leased event is transient by construction — another attempt holds it and its
 * lease expires — so it answers 503 with Retry-After, which is what "come back
 * shortly" actually means. A genuine processing failure keeps the 500 these
 * routes already returned; it is not known to be transient, and changing that
 * status is not this function's business.
 *
 * The batch is deliberately NOT continued past either one. Provider batches carry
 * consecutive messages from the same customer, so processing the siblings of a
 * message we could not finish would answer the customer's second question before
 * the first — and the redelivery replays the whole batch in order anyway.
 */
export async function inboundRetryResponse(source: string, error: unknown): Promise<NextResponse> {
  if (error instanceof InboundBotEventLeasedError) {
    await logError(source, error, "Deliberate redelivery request — the event is leased by another attempt.").catch(() => {});
    return NextResponse.json({ error: "retry" }, { status: 503, headers: { "Retry-After": "10" } });
  }
  // The inner handlers already log and release their own claim. Log again only if
  // this came from somewhere that did not.
  await logError(source, error, "Inbound webhook batch aborted — asking the provider to redeliver.").catch(() => {});
  return NextResponse.json({ error: "retry" }, { status: 500 });
}

import "server-only";

export type SmsDeliveryResult = { ok: boolean; providerMessageId?: string; error?: string };

export function isSigningSmsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SIGNING_SMS_SERVICE_URL && env.SIGNING_SMS_SERVICE_TOKEN);
}

/**
 * Provider-neutral SMS contract. The service must accept JSON {to,text,idempotencyKey}
 * and return {ok,messageId,error}. This deliberately does not silently substitute
 * WhatsApp: the evidence package records the channel that actually authenticated
 * the signer.
 */
export async function sendSigningSms(input: { to: string; text: string; idempotencyKey: string }): Promise<SmsDeliveryResult> {
  const url = process.env.SIGNING_SMS_SERVICE_URL;
  const token = process.env.SIGNING_SMS_SERVICE_TOKEN;
  if (!url || !token) return { ok: false, error: "SMS provider is not configured" };
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => ({})) as { ok?: boolean; messageId?: string; error?: string };
    if (!response.ok || body.ok === false) return { ok: false, error: body.error || `SMS provider failed: ${response.status}` };
    return { ok: true, providerMessageId: body.messageId };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "SMS provider failed" };
  }
}

import { resolveIntegrationBundle } from "@/lib/settings";
import { currentTenantScope } from "@/lib/tenantScope";
import { recordOutboundFailure, recordOutboundMessage, type OutboundRecord } from "@/lib/outboundMessageLog";

/**
 * SMS via BulkSMS (bulksms.com) — Settings → Integrations holds the token.
 * SA numbers are normalized to +27 international format.
 */
async function bulkSmsCredentials(): Promise<[string | null, string | null]> {
  const tenantId = currentTenantScope()?.tenantId ?? null;
  const bundle = await resolveIntegrationBundle(tenantId, "sms");
  if (!bundle) return [null, null];
  return [bundle.BULKSMS_TOKEN_ID, bundle.BULKSMS_TOKEN_SECRET];
}

export async function isSmsConfigured(): Promise<boolean> {
  const [id, secret] = await bulkSmsCredentials();
  return Boolean(id && secret);
}

export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10 && digits.startsWith("0")) return `+27${digits.slice(1)}`;
  if (digits.length === 11 && digits.startsWith("27")) return `+${digits}`;
  if (digits.length >= 11 && raw.trim().startsWith("+")) return `+${digits}`;
  return null;
}

export function maskPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return `••• ••• •${digits.slice(-3)}`;
}

/**
 * `record` — the customer this text is to. When given, the sent message is
 * written to their timeline once the gateway accepts it (and a failure to their
 * audit trail); see lib/outboundMessageLog.ts.
 */
export async function sendSms(to: string, body: string, record?: OutboundRecord): Promise<{ ok: boolean; error?: string }> {
  const result = await sendSmsNow(to, body);
  if (record) {
    const logged = { channel: "sms" as const, to, text: body };
    if (result.ok) await recordOutboundMessage({ ...logged, messageId: result.messageId }, record);
    else await recordOutboundFailure(logged, record, result.error);
  }
  return { ok: result.ok, error: result.error };
}

async function sendSmsNow(to: string, body: string): Promise<{ ok: boolean; error?: string; messageId?: string | null }> {
  const [id, secret] = await bulkSmsCredentials();
  if (!id || !secret) return { ok: false, error: "SMS is not configured" };
  const intl = normalizePhone(to);
  if (!intl) return { ok: false, error: "Invalid phone number" };
  try {
    const res = await fetch("https://api.bulksms.com/v1/messages", {
      signal: AbortSignal.timeout(15_000),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      },
      body: JSON.stringify({ to: intl, body }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `SMS gateway ${res.status}: ${text.slice(0, 200)}` };
    }
    // BulkSMS answers with one entry per message sent.
    const sent = (await res.json().catch(() => null)) as Array<{ id?: string }> | null;
    return { ok: true, messageId: Array.isArray(sent) ? (sent[0]?.id ?? null) : null };
  } catch (err) {
    const { logError } = await import("./errorLog");
    // Never the number: it is client information.
    await logError("sms", err, "send failed");
    return { ok: false, error: err instanceof Error ? err.message : "SMS send failed" };
  }
}

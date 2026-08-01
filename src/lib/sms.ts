import { resolveIntegrationBundle } from "@/lib/settings";
import { currentTenantScope } from "@/lib/tenantScope";

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

export async function sendSms(to: string, body: string): Promise<{ ok: boolean; error?: string }> {
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
    return { ok: true };
  } catch (err) {
    const { logError } = await import("./errorLog");
    await logError("sms", err, `to: ${to}`);
    return { ok: false, error: err instanceof Error ? err.message : "SMS send failed" };
  }
}

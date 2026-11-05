import "server-only";
import { basePrisma } from "./db";
import { DEFAULT_TENANT_ID } from "./tenant";

/** Platform-level invoice details, kept on the founding workspace's settings rows (platform console → Billing). */
export const INVOICE_FROM_KEY = "PLATFORM_INVOICE_FROM";
export const INVOICE_VAT_KEY = "PLATFORM_INVOICE_VAT_PCT";

export async function invoiceSettings(): Promise<{ fromText: string; vatRatePct: number }> {
  const rows = await basePrisma.appSetting.findMany({
    where: { tenantId: DEFAULT_TENANT_ID, key: { in: [INVOICE_FROM_KEY, INVOICE_VAT_KEY] } },
  });
  const value = (key: string) => rows.find((row) => row.key === key)?.value ?? "";
  const vat = Number(value(INVOICE_VAT_KEY));
  return { fromText: value(INVOICE_FROM_KEY), vatRatePct: Number.isFinite(vat) && vat >= 0 ? vat : 0 };
}

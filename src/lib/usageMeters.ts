/**
 * What the platform meters per workspace per month, and how a month's usage becomes an invoice.
 * Pure: no database, so the sums are tested directly (tests/usageBilling.test.ts).
 */

export type MeterId = "ai_usd_micros" | "ai_calls" | "voice_chars" | "transcriptions" | "whatsapp_sent" | "sms_sent";

/** `unit` raw counts make one billing unit; plan allowances and overage prices are per billing unit. */
export const METERS: Record<MeterId, { label: string; unit: number; unitLabel: string; billable: boolean }> = {
  ai_usd_micros: { label: "AI usage", unit: 1_000_000, unitLabel: "US$ of AI", billable: true },
  ai_calls: { label: "AI requests", unit: 1, unitLabel: "request", billable: false },
  voice_chars: { label: "Voice replies", unit: 1_000, unitLabel: "1,000 characters spoken", billable: true },
  transcriptions: { label: "Voice notes transcribed", unit: 1, unitLabel: "voice note", billable: true },
  whatsapp_sent: { label: "WhatsApp messages sent", unit: 1, unitLabel: "message", billable: true },
  sms_sent: { label: "SMS sent", unit: 1, unitLabel: "SMS", billable: true },
};

export const METER_IDS = Object.keys(METERS) as MeterId[];

/** "2026-11": the calendar month in Johannesburg, so a send at 01:00 on the 1st counts in the new month. */
export function usageMonth(at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit" }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}`;
}

/** True once a "2026-11" month is over in Johannesburg — before then its usage is still being counted. */
export function monthHasEnded(period: string, now: Date = new Date()): boolean {
  return period < usageMonth(now);
}

/** US$ per million tokens [input, output]. Cache writes cost 1.25× input, cache reads 0.1×. */
// ponytail: hand-kept price list (Anthropic list prices, 2026-11); add a row when the app starts using a new model.
// An unknown model is priced as Opus (the last row).
const MODEL_PRICES: Array<[prefix: string, input: number, output: number]> = [
  ["claude-fable", 10, 50],
  ["claude-haiku-4-5", 1, 5],
  ["claude-haiku-5-5", 0.1, 0.5],
  ["claude-sonnet-5", 2, 10],
  ["claude-sonnet-4", 3, 15],
  ["claude-opus-5-5", 4, 20],
  ["claude-opus", 5, 25],
];
const WEB_SEARCH_USD = 0.01;

export type AiUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
};

/** One response's cost in micro-dollars (US$ × 1,000,000), rounded up. */
export function aiCostMicros(usage: AiUsage, model: string | null | undefined): number {
  const [, input, output] = MODEL_PRICES.find(([prefix]) => (model ?? "").startsWith(prefix)) ?? MODEL_PRICES[MODEL_PRICES.length - 1];
  // Per-million price × tokens = micro-dollars.
  const micros =
    (usage.input_tokens ?? 0) * input +
    (usage.cache_creation_input_tokens ?? 0) * input * 1.25 +
    (usage.cache_read_input_tokens ?? 0) * input * 0.1 +
    (usage.output_tokens ?? 0) * output +
    (usage.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD * 1_000_000;
  return Math.ceil(micros);
}

export type PlanAmounts = Partial<Record<MeterId, number>>;

/** A Tenant row's plan JSON, read defensively: only known billable meters, only finite non-negative numbers. */
export function planAmounts(raw: unknown): PlanAmounts {
  const out: PlanAmounts = {};
  if (!raw || typeof raw !== "object") return out;
  for (const id of METER_IDS) {
    const value = Number((raw as Record<string, unknown>)[id]);
    if (METERS[id].billable && Number.isFinite(value) && value >= 0) out[id] = value;
  }
  return out;
}

export type InvoiceLine = { label: string; quantity: number; unitCents: number; totalCents: number };

/**
 * A month's invoice lines: the plan fee, then each billable meter's use over its allowance, in whole billing
 * units rounded up, at that meter's overage price. A meter with no overage price is never charged.
 */
export function invoiceLines(
  plan: { name: string | null; monthlyCents: number | null; included: PlanAmounts; overage: PlanAmounts },
  usage: Partial<Record<MeterId, number>>,
  period: string,
): InvoiceLine[] {
  const lines: InvoiceLine[] = [];
  if (plan.monthlyCents && plan.monthlyCents > 0) {
    lines.push({ label: `${plan.name || "Subscription"}: ${period}`, quantity: 1, unitCents: plan.monthlyCents, totalCents: plan.monthlyCents });
  }
  for (const id of METER_IDS) {
    const price = plan.overage[id];
    if (!METERS[id].billable || !price) continue;
    const used = (usage[id] ?? 0) / METERS[id].unit;
    const over = Math.ceil(used - (plan.included[id] ?? 0));
    if (over <= 0) continue;
    lines.push({ label: `${METERS[id].label} over the plan (per ${METERS[id].unitLabel})`, quantity: over, unitCents: Math.round(price), totalCents: over * Math.round(price) });
  }
  return lines;
}

export function invoiceTotals(lines: InvoiceLine[], vatRatePct: number) {
  const subtotalCents = lines.reduce((sum, line) => sum + line.totalCents, 0);
  const vatCents = Math.round((subtotalCents * vatRatePct) / 100);
  return { subtotalCents, vatCents, totalCents: subtotalCents + vatCents };
}

/** How much of a meter is used, in its billing unit (for "12.40 of 20 US$ of AI"). */
export function usedUnits(id: MeterId, raw: number): number {
  return raw / METERS[id].unit;
}

export const invoiceNumber = (n: number) => `INV-${String(n).padStart(4, "0")}`;

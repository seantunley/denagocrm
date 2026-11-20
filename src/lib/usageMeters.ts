/**
 * What the platform meters per workspace per month, and how a month's usage becomes an invoice.
 * Pure: no database, so the sums are tested directly (tests/usageBilling.test.ts).
 */
import { GENERATED_MODEL_PRICES } from "./modelPrices.generated";

export type MeterId =
  | "ai_usd_micros" | "ai_calls" | "chatgpt_tokens" | "chatgpt_calls" | "voice_chars" | "transcriptions" | "whatsapp_sent" | "sms_sent";

/** `unit` raw counts make one billing unit; plan allowances and overage prices are per billing unit. */
export const METERS: Record<MeterId, { label: string; unit: number; unitLabel: string; billable: boolean }> = {
  ai_usd_micros: { label: "AI usage", unit: 1_000_000, unitLabel: "US$ of AI", billable: true },
  ai_calls: { label: "Claude requests", unit: 1, unitLabel: "request", billable: false },
  // The workspace's own ChatGPT subscription: counted so the owner can see what uses the plan's allowance before
  // ChatGPT says it is over its limit (Sean, 2026-11-20, from Scarlet). NEVER billable: these calls cost nothing per call.
  chatgpt_tokens: { label: "ChatGPT tokens (your subscription)", unit: 1_000, unitLabel: "1,000 tokens", billable: false },
  chatgpt_calls: { label: "ChatGPT requests (your subscription)", unit: 1, unitLabel: "request", billable: false },
  voice_chars: { label: "Voice replies", unit: 1_000, unitLabel: "1,000 characters spoken", billable: true },
  transcriptions: { label: "Voice notes transcribed", unit: 1, unitLabel: "voice note", billable: true },
  whatsapp_sent: { label: "WhatsApp messages sent", unit: 1, unitLabel: "message", billable: true },
  sms_sent: { label: "SMS sent", unit: 1, unitLabel: "SMS", billable: true },
};

export const METER_IDS = Object.keys(METERS) as MeterId[];

/** The per-job split of ChatGPT tokens: a counter row "chatgpt_tokens:DAX". Not a MeterId, so billing never reads it. */
export const CHATGPT_JOB_PREFIX = "chatgpt_tokens:";
/** An AI helper's ErrorLog scope (lib/aiText) → the job it is, as the Plan page names it. */
export function chatGptJobForScope(scope: string): string {
  if (/^(bot-|flow-|chatbot-)/.test(scope)) return "Chatbot";
  if (scope.startsWith("crm-assistant")) return "DAX";
  if (scope === "inbound-screening") return "Spam screening";
  if (scope === "ai-check") return "Message check";
  if (scope === "ai-voice-note") return "Voice-note replies";
  if (scope === "knowledge-gap") return "Chatbot answer drafts";
  if (scope.includes("invoice")) return "Invoice reading";
  return "Other AI helpers";
}

export function chatGptJobMeter(job: string): string {
  return `${CHATGPT_JOB_PREFIX}${job.replace(/[^\p{L}\p{N} &/-]/gu, "").trim().slice(0, 40) || "Other"}`;
}

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

/**
 * The plan terms that applied to `period`: the latest row saved in that month or before it (TenantPlanTerms). A
 * plan saved mid-month covers that whole month; later months follow it until the next change. Null: no plan yet.
 */
export function termsInForce<T extends { month: string }>(history: T[], period: string): T | null {
  let best: T | null = null;
  for (const row of history) if (row.month <= period && (!best || row.month > best.month)) best = row;
  return best;
}

/**
 * A model not in the generated list yet (it is refreshed weekly): priced as Opus 5, so a brand-new model is never
 * costed below what it might be. Same rule the hand-kept list had.
 */
const UNLISTED_PRICE = [5, 25, 6.25, 0.5] as const;
const WEB_SEARCH_USD = 0.01;

/**
 * US$ per million tokens [input, output, cache write, cache read] for a model, from the list generated from LiteLLM's
 * public prices (scripts/update-model-prices.mjs — Sean, 2026-11-20: the hand-kept list priced every new model as
 * Opus). A dated id ("claude-haiku-4-5-20251001") takes the longest listed id it extends.
 */
export function modelPrice(model: string | null | undefined): readonly [number, number, number, number] {
  const id = model ?? "";
  const exact = GENERATED_MODEL_PRICES[id];
  if (exact) return exact;
  const base = Object.keys(GENERATED_MODEL_PRICES)
    .filter((listed) => id.startsWith(`${listed}-`))
    .sort((a, b) => b.length - a.length)[0];
  return base ? GENERATED_MODEL_PRICES[base] : UNLISTED_PRICE;
}

export type AiUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
};

/** One response's cost in micro-dollars (US$ × 1,000,000), rounded up. */
export function aiCostMicros(usage: AiUsage, model: string | null | undefined): number {
  const [input, output, cacheWrite, cacheRead] = modelPrice(model);
  // Per-million price × tokens = micro-dollars.
  const micros =
    (usage.input_tokens ?? 0) * input +
    (usage.cache_creation_input_tokens ?? 0) * cacheWrite +
    (usage.cache_read_input_tokens ?? 0) * cacheRead +
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

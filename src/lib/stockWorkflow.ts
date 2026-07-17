export const STOCK_STATUSES = [
  "incoming",
  "available",
  "reserved",
  "allocated",
  "pdi",
  "ready",
  "sold",
  "delivered",
  "hold",
  "damaged",
  "archived",
] as const;

export type StockStatus = (typeof STOCK_STATUSES)[number];

export const STOCK_STATUS_LABELS: Record<StockStatus, string> = {
  incoming: "Incoming",
  available: "Available",
  reserved: "Reserved",
  allocated: "Allocated",
  pdi: "PDI",
  ready: "Ready for delivery",
  sold: "Sold",
  delivered: "Delivered",
  hold: "On hold",
  damaged: "Damaged",
  archived: "Archived",
};

export const STOCK_STATUS_TONES: Record<
  StockStatus,
  "neutral" | "info" | "success" | "warning" | "danger"
> = {
  incoming: "info",
  available: "success",
  reserved: "warning",
  allocated: "info",
  pdi: "warning",
  ready: "success",
  sold: "neutral",
  delivered: "neutral",
  hold: "warning",
  damaged: "danger",
  archived: "neutral",
};

const TRANSITIONS: Record<StockStatus, readonly StockStatus[]> = {
  incoming: ["available", "hold", "damaged", "archived"],
  available: ["reserved", "allocated", "hold", "damaged", "archived"],
  reserved: ["available", "allocated", "hold", "damaged", "archived"],
  allocated: ["reserved", "available", "pdi", "hold", "damaged", "archived"],
  pdi: ["allocated", "ready", "hold", "damaged"],
  ready: ["pdi", "sold", "delivered", "hold", "damaged"],
  sold: ["delivered", "hold"],
  delivered: [],
  hold: ["incoming", "available", "reserved", "allocated", "pdi", "ready", "damaged", "archived"],
  damaged: ["hold", "available", "archived"],
  archived: [],
};

export function isStockStatus(value: string): value is StockStatus {
  return (STOCK_STATUSES as readonly string[]).includes(value);
}

export function canTransitionStock(from: string, to: string): boolean {
  return isStockStatus(from) && isStockStatus(to) && TRANSITIONS[from].includes(to);
}

export function allowedStockTransitions(from: string): StockStatus[] {
  return isStockStatus(from) ? [...TRANSITIONS[from]] : [];
}

export function normalizeSerial(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim().toUpperCase().replace(/\s+/g, "");
  return normalized || null;
}

export function normalizeStockNumber(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
  return normalized || null;
}

export function stockAgeDays(arrivedAt: Date | string | null, now = new Date()): number | null {
  if (!arrivedAt) return null;
  const arrived = arrivedAt instanceof Date ? arrivedAt : new Date(arrivedAt);
  if (Number.isNaN(arrived.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - arrived.getTime()) / 86_400_000));
}

export function stockAgeBand(days: number | null): "unknown" | "fresh" | "watch" | "aged" | "critical" {
  if (days == null) return "unknown";
  if (days < 30) return "fresh";
  if (days < 60) return "watch";
  if (days < 90) return "aged";
  return "critical";
}

export function reservationUrgency(expiresAt: Date | string | null, now = new Date()): "none" | "expired" | "today" | "soon" | "healthy" {
  if (!expiresAt) return "none";
  const expiry = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) return "none";
  const hours = (expiry.getTime() - now.getTime()) / 3_600_000;
  if (hours < 0) return "expired";
  if (hours <= 24) return "today";
  if (hours <= 72) return "soon";
  return "healthy";
}

export function reorderRecommendation(input: {
  openDemand: number;
  available: number;
  incoming: number;
  reserved: number;
  safetyStock?: number;
}): number {
  const safety = Math.max(0, input.safetyStock ?? 1);
  const netSupply = Math.max(0, input.available) + Math.max(0, input.incoming) - Math.max(0, input.reserved);
  return Math.max(0, Math.ceil(Math.max(0, input.openDemand) + safety - netSupply));
}

export function allocateLandedCost(
  lines: Array<{ key: string; qty: number; unitCostCents: number }>,
  overheadCents: number,
): Record<string, number> {
  const normalized = lines.map((line) => ({
    ...line,
    qty: Math.max(0, Math.floor(line.qty)),
    unitCostCents: Math.max(0, Math.floor(line.unitCostCents)),
  }));
  const baseTotal = normalized.reduce((sum, line) => sum + line.qty * line.unitCostCents, 0);
  const totalQty = normalized.reduce((sum, line) => sum + line.qty, 0);
  const overhead = Math.max(0, Math.floor(overheadCents));
  const result: Record<string, number> = {};
  let distributed = 0;

  normalized.forEach((line, index) => {
    if (line.qty === 0) {
      result[line.key] = line.unitCostCents;
      return;
    }
    const weight = baseTotal > 0
      ? (line.qty * line.unitCostCents) / baseTotal
      : totalQty > 0
        ? line.qty / totalQty
        : 0;
    const lineOverhead = index === normalized.length - 1
      ? overhead - distributed
      : Math.round(overhead * weight);
    distributed += lineOverhead;
    result[line.key] = line.unitCostCents + Math.round(lineOverhead / line.qty);
  });

  return result;
}

export function stockStatusPriority(status: string): number {
  return {
    damaged: 0,
    hold: 1,
    ready: 2,
    pdi: 3,
    allocated: 4,
    reserved: 5,
    available: 6,
    incoming: 7,
    sold: 8,
    delivered: 9,
    archived: 10,
  }[status] ?? 99;
}

export const ACTIVE_STOCK_STATUSES: StockStatus[] = [
  "incoming",
  "available",
  "reserved",
  "allocated",
  "pdi",
  "ready",
  "hold",
  "damaged",
];

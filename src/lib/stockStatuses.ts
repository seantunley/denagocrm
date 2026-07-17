import { prisma } from "@/lib/db";
import { STOCK_STATUS_LABELS, type StockStatus } from "@/lib/stockWorkflow";

/**
 * Fixed operational statuses drive purchasing, reservations, allocation, PDI and
 * delivery. Custom statuses are optional organisational holding labels for units
 * that are not committed to a customer workflow.
 */
export type StockStatusOption = {
  slug: string;
  label: string;
  color: string;
  system: boolean;
};

const SETTING_KEY = "stock.custom_statuses";

const SYSTEM_COLORS: Record<StockStatus, string> = {
  incoming: "#38bdf8",
  available: "#34d399",
  reserved: "#fbbf24",
  allocated: "#60a5fa",
  pdi: "#fb923c",
  ready: "#22c55e",
  sold: "#94a3b8",
  delivered: "#64748b",
  hold: "#f59e0b",
  damaged: "#f87171",
  archived: "#64748b",
};

export const SYSTEM_STOCK_STATUSES: StockStatusOption[] = (
  Object.keys(STOCK_STATUS_LABELS) as StockStatus[]
).map((slug) => ({
  slug,
  label: STOCK_STATUS_LABELS[slug],
  color: SYSTEM_COLORS[slug],
  system: true,
}));

const SYSTEM_SLUGS = new Set(SYSTEM_STOCK_STATUSES.map((status) => status.slug));

export function isSystemStockStatus(slug: string): boolean {
  return SYSTEM_SLUGS.has(slug);
}

export function slugifyStatus(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

export async function getCustomStockStatuses(): Promise<StockStatusOption[]> {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTING_KEY } });
  if (!row) return [];
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (status): status is { slug: string; label: string; color?: string } =>
          Boolean(status) &&
          typeof (status as { slug?: unknown }).slug === "string" &&
          typeof (status as { label?: unknown }).label === "string" &&
          !SYSTEM_SLUGS.has((status as { slug: string }).slug),
      )
      .map((status) => ({
        slug: status.slug,
        label: status.label,
        color: typeof status.color === "string" && /^#[0-9a-f]{6}$/i.test(status.color)
          ? status.color
          : "#64748b",
        system: false,
      }));
  } catch {
    return [];
  }
}

export async function getStockStatuses(): Promise<StockStatusOption[]> {
  return [...SYSTEM_STOCK_STATUSES, ...(await getCustomStockStatuses())];
}

export async function saveCustomStockStatuses(list: StockStatusOption[]): Promise<void> {
  const clean = list
    .filter((status) => !SYSTEM_SLUGS.has(status.slug))
    .map((status) => ({ slug: status.slug, label: status.label, color: status.color }));
  await prisma.appSetting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value: JSON.stringify(clean) },
    update: { value: JSON.stringify(clean) },
  });
}

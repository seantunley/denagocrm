import { getSetting, putSetting } from "@/lib/settings";

/**
 * Stock statuses. The four built-ins are load-bearing — the receiving, reserve and
 * sell flows key off these exact slugs — so they are fixed and can't be removed.
 * Custom statuses are user-defined organizational labels (e.g. In transit, Damaged,
 * Demo) stored as JSON in AppSetting, so adding/removing them needs no migration.
 */
export type StockStatusOption = {
  slug: string;
  label: string;
  color: string; // hex, e.g. #34d399
  system: boolean;
};

const SETTING_KEY = "stock.custom_statuses";

export const SYSTEM_STOCK_STATUSES: StockStatusOption[] = [
  { slug: "incoming", label: "On order", color: "#38bdf8", system: true },
  { slug: "available", label: "Available", color: "#34d399", system: true },
  { slug: "reserved", label: "Reserved", color: "#fbbf24", system: true },
  { slug: "sold", label: "Sold", color: "#94a3b8", system: true },
];

const SYSTEM_SLUGS = new Set(SYSTEM_STOCK_STATUSES.map((s) => s.slug));

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
  const value = await getSetting(SETTING_KEY);
  if (value === null) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (s): s is { slug: string; label: string; color?: string } =>
          !!s &&
          typeof (s as { slug?: unknown }).slug === "string" &&
          typeof (s as { label?: unknown }).label === "string" &&
          !SYSTEM_SLUGS.has((s as { slug: string }).slug),
      )
      .map((s) => ({
        slug: s.slug,
        label: s.label,
        color: typeof s.color === "string" ? s.color : "#64748b",
        system: false,
      }));
  } catch {
    return [];
  }
}

export async function getStockStatuses(): Promise<StockStatusOption[]> {
  return [...SYSTEM_STOCK_STATUSES, ...(await getCustomStockStatuses())];
}

/** Persist the custom-status list (system statuses are never stored). */
export async function saveCustomStockStatuses(list: StockStatusOption[]): Promise<void> {
  const clean = list
    .filter((s) => !SYSTEM_SLUGS.has(s.slug))
    .map((s) => ({ slug: s.slug, label: s.label, color: s.color }));
  await putSetting(SETTING_KEY, JSON.stringify(clean));
}

import "server-only";

import { prisma } from "@/lib/db";

/**
 * Organisational stock labels — a configurable list, DISTINCT from the fixed
 * lifecycle `status`. A unit is in exactly one lifecycle state (incoming …
 * delivered) and may additionally carry one optional label (demo, showroom,
 * consignment, management hold …). Stored as JSON in AppSetting, so adding or
 * removing a label needs no migration.
 */
export type StockLabel = { slug: string; label: string; color: string };

const SETTING_KEY = "stock.labels";

/** Sensible starters; the list is fully user-editable in settings. */
export const DEFAULT_STOCK_LABELS: StockLabel[] = [
  { slug: "demo", label: "Demo unit", color: "#8b5cf6" },
  { slug: "showroom", label: "Showroom floor", color: "#0ea5e9" },
  { slug: "consignment", label: "Consignment", color: "#f59e0b" },
  { slug: "management-hold", label: "Management hold", color: "#ef4444" },
];

export function slugifyLabel(label: string): string {
  return label.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
}

export async function getStockLabels(): Promise<StockLabel[]> {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTING_KEY } });
  if (!row) return DEFAULT_STOCK_LABELS;
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (s): s is StockLabel =>
          !!s &&
          typeof (s as { slug?: unknown }).slug === "string" &&
          typeof (s as { label?: unknown }).label === "string",
      )
      .map((s) => ({ slug: s.slug, label: s.label, color: typeof s.color === "string" ? s.color : "#64748b" }));
  } catch {
    return [];
  }
}

export async function saveStockLabels(list: StockLabel[]): Promise<void> {
  const clean = list.map((s) => ({ slug: s.slug, label: s.label, color: s.color }));
  await prisma.appSetting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value: JSON.stringify(clean) },
    update: { value: JSON.stringify(clean) },
  });
}

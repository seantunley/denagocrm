"use server";

import { revalidatePath } from "next/cache";
import { logAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/permissions";
import {
  getCustomStockStatuses,
  isSystemStockStatus,
  saveCustomStockStatuses,
  slugifyStatus,
  type StockStatusOption,
} from "@/lib/stockStatuses";
import {
  restoreUnitsFromRemovedCustomStatus,
  setCustomStockUnitStatus,
} from "@/lib/customStockStatusOperations";

const value = (formData: FormData, key: string) => String(formData.get(key) ?? "").trim();

function refresh(id?: string) {
  revalidatePath("/stock");
  if (id) revalidatePath(`/stock/${id}`);
}

export async function addStockStatus(formData: FormData) {
  const user = await requirePermission("stock.manage");
  const label = value(formData, "label");
  const color = value(formData, "color") || "#64748b";
  if (!label) throw new Error("Status label is required");
  const slug = slugifyStatus(label);
  if (!slug || isSystemStockStatus(slug)) throw new Error("That status name is reserved");
  const custom = await getCustomStockStatuses();
  if (custom.some((status) => status.slug === slug)) throw new Error("That custom status already exists");
  const next: StockStatusOption[] = [
    ...custom,
    { slug, label, color: /^#[0-9a-f]{6}$/i.test(color) ? color : "#64748b", system: false },
  ];
  await saveCustomStockStatuses(next);
  await logAudit({ action: "stock.status_added", summary: `Added custom stock status “${label}”`, user });
  refresh();
}

export async function removeStockStatus(slug: string) {
  const user = await requirePermission("stock.manage");
  if (isSystemStockStatus(slug)) throw new Error("Operational statuses cannot be removed");
  const custom = await getCustomStockStatuses();
  const removed = custom.find((status) => status.slug === slug);
  if (!removed) return;
  await restoreUnitsFromRemovedCustomStatus({ slug, actor: { id: user.id, name: user.name } });
  await saveCustomStockStatuses(custom.filter((status) => status.slug !== slug));
  await logAudit({
    action: "stock.status_removed",
    summary: `Removed custom stock status “${removed.label}”; affected units were restored to Available`,
    user,
  });
  refresh();
}

export async function setStockStatus(unitId: string, formData: FormData) {
  const user = await requirePermission("stock.manage");
  const slug = value(formData, "status");
  const reason = value(formData, "reason");
  await setCustomStockUnitStatus({
    stockUnitId: unitId,
    slug,
    reason,
    actor: { id: user.id, name: user.name },
  });
  await logAudit({
    action: "stock.status_set",
    summary: `Applied custom stock status “${slug}” — ${reason}`,
    user,
  });
  refresh(unitId);
}

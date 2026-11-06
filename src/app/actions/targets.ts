"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireTenantOwner } from "@/lib/auth";
import { parseMoneyField } from "@/lib/moneyInput";
import { getRegionalSettings } from "@/lib/settings";
import { withActingStaffScope } from "@/lib/actingScope";

const TARGET_METRICS = ["leads", "sales_value", "deliveries", "services"] as const;

/** Upsert this-period targets. sales_value comes in as Rands, stored as cents. */
export async function saveTargets(period: string, formData: FormData) {
  return withActingStaffScope(async () => {
    await requireTenantOwner();
    const { currency } = await getRegionalSettings();
    for (const metric of TARGET_METRICS) {
      const raw = String(formData.get(metric) ?? "").trim();
      if (raw === "") continue;
      // Sales value is money, read strictly in the workspace's currency (moneyInput.ts).
      const money = metric === "sales_value" ? parseMoneyField(raw, currency) : null;
      if (money && !money.ok) throw new Error(`Sales value target: ${money.error}`);
      const value = money ? money.cents ?? 0 : Math.max(0, parseInt(raw, 10) || 0);
      await prisma.target.upsert({
        where: { metric_period: { metric, period } },
        create: { metric, period, value },
        update: { value },
      });
    }
    revalidatePath("/targets");
  });
}

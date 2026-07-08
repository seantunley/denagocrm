"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { parseRands } from "@/lib/format";

const TARGET_METRICS = ["leads", "sales_value", "deliveries", "services"] as const;

/** Upsert this-period targets. sales_value comes in as Rands, stored as cents. */
export async function saveTargets(period: string, formData: FormData) {
  await requireOwner();
  for (const metric of TARGET_METRICS) {
    const raw = String(formData.get(metric) ?? "").trim();
    if (raw === "") continue;
    const value =
      metric === "sales_value" ? parseRands(raw) ?? 0 : Math.max(0, parseInt(raw, 10) || 0);
    await prisma.target.upsert({
      where: { metric_period: { metric, period } },
      create: { metric, period, value },
      update: { value },
    });
  }
  revalidatePath("/targets");
}

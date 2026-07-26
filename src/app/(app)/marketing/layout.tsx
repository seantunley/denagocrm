import type { ReactNode } from "react";
import { requireModuleEnabled } from "@/lib/modules/enabled";

export default async function MarketingLayout({ children }: { children: ReactNode }) {
  await requireModuleEnabled("marketing");
  return children;
}

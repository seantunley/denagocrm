import type { ReactNode } from "react";
import { requireModuleEnabled } from "@/lib/modules/enabled";
import MarketingWorkspaceShell from "@/components/marketing/MarketingWorkspaceShell";

export default async function MarketingLayout({ children }: { children: ReactNode }) {
  await requireModuleEnabled("marketing");
  return <MarketingWorkspaceShell>{children}</MarketingWorkspaceShell>;
}

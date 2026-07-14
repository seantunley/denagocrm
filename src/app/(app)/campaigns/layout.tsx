import { requireAnyPermission } from "@/lib/permissions";

export default async function CampaignsLayout({ children }: { children: React.ReactNode }) {
  await requireAnyPermission("campaigns.view", "campaigns.manage");
  return children;
}

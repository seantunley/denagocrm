import { requireAnyPermission } from "@/lib/permissions";

export default async function SurveysLayout({ children }: { children: React.ReactNode }) {
  await requireAnyPermission("surveys.view", "surveys.manage");
  return children;
}

import type { ReactNode } from "react";
import { requireTenantOwner } from "@/lib/auth";
import ChatbotWorkspaceNav from "@/components/ChatbotWorkspaceNav";

export default async function BotAnalyticsWorkspaceLayout({ children }: { children: ReactNode }) {
  await requireTenantOwner();
  return (
    <div className="min-w-0">
      <ChatbotWorkspaceNav />
      <main className="min-w-0">{children}</main>
    </div>
  );
}

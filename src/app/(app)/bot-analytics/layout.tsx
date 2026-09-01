import type { ReactNode } from "react";
import { requireOwner } from "@/lib/auth";
import ChatbotWorkspaceNav from "@/components/ChatbotWorkspaceNav";

export default async function BotAnalyticsWorkspaceLayout({ children }: { children: ReactNode }) {
  await requireOwner();
  return (
    <div className="min-w-0">
      <ChatbotWorkspaceNav />
      <main className="min-w-0">{children}</main>
    </div>
  );
}

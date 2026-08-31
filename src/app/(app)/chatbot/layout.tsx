import type { ReactNode } from "react";
import { requireOwner } from "@/lib/auth";
import ChatbotWorkspaceNav from "@/components/ChatbotWorkspaceNav";

export default async function ChatbotWorkspaceLayout({ children }: { children: ReactNode }) {
  await requireOwner();
  return (
    <div className="lg:flex lg:items-start lg:gap-5">
      <ChatbotWorkspaceNav />
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}

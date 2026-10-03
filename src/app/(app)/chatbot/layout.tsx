import { requireRoute } from "@/lib/permissions";
import type { ReactNode } from "react";
import ChatbotWorkspaceNav from "@/components/ChatbotWorkspaceNav";

export default async function ChatbotWorkspaceLayout({ children }: { children: ReactNode }) {
  await requireRoute("/chatbot");
  return (
    <div className="min-w-0">
      <ChatbotWorkspaceNav />
      <main className="min-w-0">{children}</main>
    </div>
  );
}

import type { ReactNode } from "react";
import Link from "next/link";
import { Bot, BrainCircuit, GitBranch } from "lucide-react";

export default function ChatbotWorkspaceLayout({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-4">
      <nav aria-label="Chatbot tools" className="flex flex-wrap gap-2 rounded-xl border border-border bg-card/60 p-2">
        <Link href="/chatbot" className="btn-secondary btn-sm"><Bot className="size-3.5" />Settings &amp; knowledge</Link>
        <Link href="/chatbot/preview" className="btn-secondary btn-sm"><BrainCircuit className="size-3.5" />Test AI answers</Link>
        <Link href="/bot-builder" className="btn-secondary btn-sm"><GitBranch className="size-3.5" />Flow library</Link>
      </nav>
      {children}
    </div>
  );
}

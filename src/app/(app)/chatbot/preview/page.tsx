import Link from "next/link";
import { BrainCircuit, ShieldCheck } from "lucide-react";
import { requireOwner } from "@/lib/auth";
import BotAiPreviewConsole from "@/components/BotAiPreviewConsole";
import { WorkspaceHero } from "@/components/workspace-hero";

export default async function ChatbotPreviewPage() {
  await requireOwner();
  return (
    <div className="space-y-5">
      <WorkspaceHero
        icon={BrainCircuit}
        eyebrow="Assistant evaluation"
        title="Answer preview"
        description="Run real customer questions through the production answer decision without sending anything or changing customer, booking or lead data."
        stats={[
          { label: "Mode", value: "Read-only", icon: ShieldCheck, tone: "success" },
          { label: "Decision", value: "Production AI", icon: BrainCircuit },
        ]}
        actions={<Link href="/chatbot" className="btn-secondary btn-sm">← Chatbot settings</Link>}
      />
      <BotAiPreviewConsole />
    </div>
  );
}
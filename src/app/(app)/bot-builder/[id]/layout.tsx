import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, BarChart3, Blocks, FlaskConical, History, ListChecks, Pencil } from "lucide-react";
import { requireOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { flowScope } from "@/lib/flowScope";
import { StatusPill } from "@/components/visual-system";

const channelLabel: Record<string, string> = {
  whatsapp: "WhatsApp",
  messenger: "Messenger",
  instagram: "Instagram",
  telegram: "Telegram",
};

export default async function FlowWorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  await requireOwner();
  const { id } = await params;
  const scope = await flowScope();
  const flow = await prisma.botFlow.findFirst({ where: { id, ...scope }, select: { id: true, name: true, channel: true, active: true } });
  if (!flow) notFound();

  const encoded = encodeURIComponent(id);
  return (
    <div className="min-w-0 space-y-3">
      <section className="border-b border-border/80 pb-2" aria-label="Current flow">
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/bot-builder" className="btn-secondary btn-sm min-h-11 shrink-0 sm:min-h-9"><ArrowLeft className="size-3.5" />Flows</Link>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="max-w-full truncate text-sm font-semibold sm:text-base">{flow.name}</h2>
              <StatusPill tone="neutral">{channelLabel[flow.channel] ?? flow.channel}</StatusPill>
              <StatusPill tone={flow.active ? "success" : "warning"}>{flow.active ? "Live" : "Draft"}</StatusPill>
            </div>
          </div>

          <nav aria-label="Flow tools" className="flex max-w-full gap-1 overflow-x-auto [scrollbar-width:thin]">
            <Link href={`/bot-builder/${encoded}`} className="btn-secondary btn-sm min-h-11 shrink-0 sm:min-h-9"><Pencil className="size-3.5" />Draft</Link>
            <Link href={`/bot-builder/${encoded}/test`} className="btn-secondary btn-sm min-h-11 shrink-0 sm:min-h-9"><FlaskConical className="size-3.5" />Simulator</Link>
            <Link href={`/bot-builder/${encoded}/evaluations`} className="btn-secondary btn-sm min-h-11 shrink-0 sm:min-h-9"><ListChecks className="size-3.5" />Evaluations</Link>
            <Link href={`/bot-builder/${encoded}/versions`} className="btn-secondary btn-sm min-h-11 shrink-0 sm:min-h-9"><History className="size-3.5" />Versions</Link>
            <Link href={`/bot-builder/${encoded}/blocks`} className="btn-secondary btn-sm min-h-11 shrink-0 sm:min-h-9"><Blocks className="size-3.5" />Blocks</Link>
            <Link href={`/bot-analytics?flowId=${encoded}`} className="btn-secondary btn-sm min-h-11 shrink-0 sm:min-h-9"><BarChart3 className="size-3.5" />Analytics</Link>
          </nav>
        </div>
      </section>
      {children}
    </div>
  );
}

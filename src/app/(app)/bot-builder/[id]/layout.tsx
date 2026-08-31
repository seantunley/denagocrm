import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BarChart3, Blocks, FlaskConical, History, ListChecks, Pencil } from "lucide-react";
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
    <div className="space-y-4">
      <section className="rounded-2xl border border-border bg-card/70 px-4 py-3" aria-label="Current flow">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Current flow</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <h2 className="truncate text-base font-semibold">{flow.name}</h2>
              <StatusPill tone="neutral">{channelLabel[flow.channel] ?? flow.channel}</StatusPill>
              <StatusPill tone={flow.active ? "success" : "warning"}>{flow.active ? "Live" : "Draft"}</StatusPill>
            </div>
          </div>
          <Link href="/bot-builder" className="btn-secondary btn-sm">All flows</Link>
        </div>
      </section>

      <nav aria-label="Flow tools" className="flex gap-2 overflow-x-auto rounded-xl border border-border bg-card/60 p-2 [scrollbar-width:thin]">
        <Link href={`/bot-builder/${encoded}`} className="btn-secondary btn-sm min-h-11 shrink-0"><Pencil className="size-3.5" />Draft</Link>
        <Link href={`/bot-builder/${encoded}/test`} className="btn-secondary btn-sm min-h-11 shrink-0"><FlaskConical className="size-3.5" />Simulator</Link>
        <Link href={`/bot-builder/${encoded}/evaluations`} className="btn-secondary btn-sm min-h-11 shrink-0"><ListChecks className="size-3.5" />Evaluations</Link>
        <Link href={`/bot-builder/${encoded}/versions`} className="btn-secondary btn-sm min-h-11 shrink-0"><History className="size-3.5" />Versions</Link>
        <Link href={`/bot-builder/${encoded}/blocks`} className="btn-secondary btn-sm min-h-11 shrink-0"><Blocks className="size-3.5" />Reusable blocks</Link>
        <Link href={`/bot-analytics?flowId=${encoded}`} className="btn-secondary btn-sm min-h-11 shrink-0"><BarChart3 className="size-3.5" />Analytics</Link>
      </nav>
      {children}
    </div>
  );
}

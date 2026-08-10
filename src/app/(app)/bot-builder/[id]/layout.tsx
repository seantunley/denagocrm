import type { ReactNode } from "react";
import Link from "next/link";
import { BarChart3, Blocks, History, Pencil } from "lucide-react";
import { requireOwner } from "@/lib/auth";

export default async function FlowWorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  await requireOwner();
  const { id } = await params;
  const encoded = encodeURIComponent(id);
  return (
    <div className="space-y-4">
      <nav aria-label="Flow tools" className="flex flex-wrap gap-2 rounded-xl border border-border bg-card/60 p-2">
        <Link href={`/bot-builder/${encoded}`} className="btn-secondary btn-sm"><Pencil className="size-3.5" />Draft</Link>
        <Link href={`/bot-builder/${encoded}/versions`} className="btn-secondary btn-sm"><History className="size-3.5" />Versions</Link>
        <Link href={`/bot-builder/${encoded}/blocks`} className="btn-secondary btn-sm"><Blocks className="size-3.5" />Reusable blocks</Link>
        <Link href={`/bot-analytics?flowId=${encoded}`} className="btn-secondary btn-sm"><BarChart3 className="size-3.5" />Analytics</Link>
      </nav>
      {children}
    </div>
  );
}

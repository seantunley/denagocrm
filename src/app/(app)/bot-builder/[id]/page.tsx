import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { DEFAULT_FLOW, type Flow } from "@/lib/flow";
import FlowBuilder from "@/components/FlowBuilder";

export default async function FlowEditorPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;
  const row = await prisma.botFlow.findUnique({ where: { id } });
  if (!row) notFound();

  let flow: Flow = DEFAULT_FLOW;
  try {
    const f = JSON.parse(row.definition);
    if (f?.start && f?.nodes) flow = f;
  } catch {
    /* use default */
  }

  return (
    <div className="space-y-4">
      <div>
        <Link href="/bot-builder" className="text-sm text-orange-400 hover:underline">← All flows</Link>
        <div className="flex items-center gap-3 mt-1 flex-wrap">
          <h1 className="text-2xl font-bold">{row.name}</h1>
          {row.active && <span className="badge bg-emerald-500/15 text-emerald-300">Live</span>}
        </div>
        <p className="text-sm text-slate-400 mt-0.5">
          Add nodes, drag from a node&apos;s right dot to another to connect them, then Save.
        </p>
      </div>
      <FlowBuilder flowId={row.id} initial={flow} />
    </div>
  );
}

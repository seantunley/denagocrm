import Link from "next/link";
import { notFound } from "next/navigation";
import { FlaskConical } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { DEFAULT_FLOW, type Flow } from "@/lib/flow";
import { validateFlow } from "@/lib/flowValidation";
import { enabledFlowChannels } from "@/lib/flowValidationServer";
import FlowBuilder from "@/components/FlowBuilder";
import FlowAiDraftForm from "@/components/FlowAiDraftForm";
import FlowLintPanel from "@/components/FlowLintPanel";

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
  const channels = await enabledFlowChannels();
  const issues = validateFlow(flow, channels);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <Link href="/bot-builder" className="text-sm text-orange-400 hover:underline">← All flows</Link>
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            <h1 className="text-2xl font-semibold tracking-[-0.035em]">{row.name}</h1>
            {row.active && <span className="badge bg-emerald-500/15 text-emerald-300">Published flow</span>}
          </div>
          <p className="text-sm text-slate-400 mt-0.5">
            You are editing a draft. Save keeps these changes private; publish them from All flows when they are ready for customers.
          </p>
        </div>
        <Link href={`/bot-builder/${row.id}/test`} className="btn-secondary btn-sm"><FlaskConical className="size-4" />Test saved draft</Link>
      </div>
      <FlowAiDraftForm flowId={row.id} />
      <FlowLintPanel issues={issues} channels={channels} />
      <FlowBuilder flowId={row.id} initial={flow} />
    </div>
  );
}

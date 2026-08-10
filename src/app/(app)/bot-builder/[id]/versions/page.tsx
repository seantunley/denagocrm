import Link from "next/link";
import { notFound } from "next/navigation";
import { History, RotateCcw, ShieldCheck } from "lucide-react";
import { Prisma } from "@prisma/client";
import { requireOwner } from "@/lib/auth";
import { basePrisma, prisma } from "@/lib/db";
import { DEFAULT_TENANT_ID } from "@/lib/tenant";
import { writeTenantId } from "@/lib/tenantWrite";
import { restoreFlowVersionToDraft } from "@/app/actions/flowVersions";
import { WorkspaceHero } from "@/components/workspace-hero";
import { EmptyState, StatusPill, Surface } from "@/components/visual-system";

type VersionRow = {
  id: string;
  version: number;
  definition: string;
  publishedAt: Date;
};

function nodeCount(definition: string): number {
  try {
    const parsed = JSON.parse(definition);
    return parsed?.nodes && typeof parsed.nodes === "object" ? Object.keys(parsed.nodes).length : 0;
  } catch {
    return 0;
  }
}

export default async function FlowVersionsPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;
  const flow = await prisma.botFlow.findUnique({ where: { id } });
  if (!flow) notFound();
  const tenantId = writeTenantId() ?? DEFAULT_TENANT_ID;
  const versions = await basePrisma.$queryRaw<VersionRow[]>(Prisma.sql`
    SELECT "id", "version", "definition", "publishedAt"
      FROM "BotFlowVersion"
     WHERE "tenantId" = ${tenantId}
       AND "flowId" = ${flow.id}
     ORDER BY "version" DESC
  `);

  return (
    <div className="space-y-5">
      <WorkspaceHero
        icon={History}
        eyebrow="Published conversation history"
        title={`${flow.name} · versions`}
        description="Inspect immutable published snapshots and restore an older one into the draft without changing what live or in-progress customer conversations are currently running."
        stats={[
          { label: "Published versions", value: versions.length, icon: History },
          { label: "Live flow", value: flow.active ? "Yes" : "No", icon: ShieldCheck, tone: flow.active ? "success" : "default" },
        ]}
        actions={<Link href={`/bot-builder/${flow.id}`} className="btn-secondary btn-sm">← Back to draft</Link>}
      />

      <Surface className="border-amber-400/20 bg-amber-500/[0.04] p-4">
        <div className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-amber-300" />
          <div><p className="text-sm font-medium text-amber-100">Restore means “copy into draft”, not “change live now”</p><p className="mt-1 text-xs leading-5 text-amber-100/70">After restoring, review the canvas, simulator and compiler, then use the normal Publish action. Publishing creates a new immutable version. Existing conversations stay pinned to the version they started on.</p></div>
        </div>
      </Surface>

      {versions.length === 0 ? (
        <EmptyState icon={History} title="No published versions yet" description="Publish this flow once and its immutable history will appear here." />
      ) : (
        <div className="space-y-3">
          {versions.map((version, index) => (
            <Surface key={version.id} className="p-5">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <div className="flex items-center gap-2"><h2 className="font-semibold">Version {Number(version.version)}</h2>{index === 0 && flow.active ? <StatusPill tone="success">Current published</StatusPill> : null}</div>
                  <p className="mt-1 text-xs text-muted-foreground">Published {version.publishedAt.toLocaleString("en-ZA")} · {nodeCount(version.definition)} node{nodeCount(version.definition) === 1 ? "" : "s"}</p>
                  <p className="mt-1 font-mono text-[10px] text-muted-foreground">{version.id}</p>
                </div>
                <form action={restoreFlowVersionToDraft.bind(null, flow.id, version.id)}>
                  <input type="hidden" name="expectedUpdatedAt" value={flow.updatedAt.toISOString()} />
                  <button className="btn-secondary btn-sm"><RotateCcw className="size-3.5" />Restore to draft</button>
                </form>
              </div>
            </Surface>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-3 text-xs">
        <Link href={`/bot-builder/${flow.id}`} className="text-orange-400 hover:underline">Open draft</Link>
        <Link href={`/bot-analytics?flowId=${encodeURIComponent(flow.id)}`} className="text-orange-400 hover:underline">View flow analytics</Link>
      </div>
    </div>
  );
}

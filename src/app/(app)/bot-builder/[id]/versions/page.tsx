import { requireRoute } from "@/lib/permissions";
import Link from "next/link";
import { notFound } from "next/navigation";
import { History, RotateCcw, ShieldCheck } from "lucide-react";
import { Prisma } from "@prisma/client";
import { basePrisma, prisma } from "@/lib/db";
import { DEFAULT_TENANT_ID } from "@/lib/tenant";
import { writeTenantId } from "@/lib/tenantWrite";
import { restoreFlowVersionToDraft } from "@/app/actions/flowVersions";
import { WorkspaceHero } from "@/components/workspace-hero";
import { EmptyState, StatusPill, Surface } from "@/components/visual-system";
import { builderTenantId } from "@/lib/flowScope";
import { flowTenantWhere } from "@/lib/flowTenantScope";
import { diffFlowVersions, noDifferences, type FlowVersionDiff } from "@/lib/flowVersionDiff";

/** One diff, in words: steps added / removed / edited, and the connections that moved. */
function DiffList({ diff, same }: { diff: FlowVersionDiff; same: string }) {
  if (!diff.comparable) return <p className="mt-2 text-xs text-muted-foreground">One of these versions can&apos;t be read, so they can&apos;t be compared.</p>;
  if (noDifferences(diff)) return <p className="mt-2 text-xs text-muted-foreground">{same}</p>;
  const section = (title: string, items: string[], tone: string) =>
    items.length > 0 && (
      <div>
        <p className={`text-[10px] font-semibold uppercase tracking-wide ${tone}`}>{title} ({items.length})</p>
        <ul className="mt-1 space-y-0.5 text-xs">{items.slice(0, 40).map((item, i) => <li key={i}>{item}</li>)}{items.length > 40 && <li className="text-muted-foreground">…and {items.length - 40} more</li>}</ul>
      </div>
    );
  return (
    <div className="mt-2 grid gap-3 md:grid-cols-2">
      {diff.startChanged && <p className="text-xs md:col-span-2">Starts at “{diff.startChanged.to}” instead of “{diff.startChanged.from}”.</p>}
      {section("Steps added", diff.added, "text-emerald-300")}
      {section("Steps removed", diff.removed, "text-red-300")}
      {section("Steps edited", diff.changed.map((c) => `${c.label} — ${c.fields.join(", ")}`), "text-amber-300")}
      {section("Connections added", diff.connectionsAdded, "text-emerald-300")}
      {section("Connections removed", diff.connectionsRemoved, "text-red-300")}
    </div>
  );
}

/**
 * `createdAt`, because that is the column that exists.
 *
 * This read asked for `publishedAt`, which BotFlowVersion has never had — the
 * model is id / tenantId / flowId / channel / version / definition /
 * createdById / createdAt. Postgres answered `42703: column "publishedAt" does
 * not exist` on EVERY request, so this page has been a guaranteed error boundary
 * for anyone who clicked "versions", not an intermittent fault.
 *
 * Nothing caught it because the query is raw: `$queryRaw<VersionRow[]>` asserts
 * the row shape rather than deriving it, so the compiler was told the column
 * existed and had no way to disagree. A model read
 * (`prisma.botFlowVersion.findMany`) would not have compiled.
 *
 * A row IS the publication — `publishFlowSnapshot` inserts one at the moment a
 * version is published — so `createdAt` is the publication instant, and the
 * label below still reads "Published".
 */
type VersionRow = {
  id: string;
  version: number;
  definition: string;
  createdAt: Date;
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
  await requireRoute("/bot-builder");
  const { id } = await params;
  const tenantId = await builderTenantId();
  const scope = flowTenantWhere(tenantId);
  const flow = await prisma.botFlow.findFirst({ where: { id, ...scope } });
  if (!flow) notFound();
  const versions = await basePrisma.$queryRaw<VersionRow[]>(Prisma.sql`
    SELECT "id", "version", "definition", "createdAt"
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
        description="See what changed in each published version, preview how restoring one would change your draft, and restore it without changing what live or in-progress customer conversations are running."
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
                  <p className="mt-1 text-xs text-muted-foreground">Published {version.createdAt.toLocaleString("en-ZA")} · {nodeCount(version.definition)} node{nodeCount(version.definition) === 1 ? "" : "s"}</p>
                  <p className="mt-1 font-mono text-[10px] text-muted-foreground">{version.id}</p>
                </div>
                <form action={restoreFlowVersionToDraft.bind(null, flow.id, version.id)}>
                  <input type="hidden" name="expectedUpdatedAt" value={flow.updatedAt.toISOString()} />
                  <button className="btn-secondary btn-sm"><RotateCcw className="size-3.5" />Restore to draft</button>
                </form>
              </div>
              <div className="mt-3 space-y-2">
                {versions[index + 1] && (
                  <details className="rounded-lg border border-white/10 px-3 py-2">
                    <summary className="cursor-pointer text-xs font-medium">What changed from version {Number(versions[index + 1].version)}</summary>
                    <DiffList diff={diffFlowVersions(versions[index + 1].definition, version.definition)} same="Nothing changed — it was published again as it was." />
                  </details>
                )}
                <details className="rounded-lg border border-white/10 px-3 py-2">
                  <summary className="cursor-pointer text-xs font-medium">Preview restore — how your draft would change</summary>
                  <DiffList diff={diffFlowVersions(flow.definition, version.definition)} same="Your draft already matches this version." />
                </details>
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

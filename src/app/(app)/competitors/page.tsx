import Link from "next/link";
import { AlertTriangle, ArrowUpRight, Eye, Globe2, Plus, Radar, ShieldCheck } from "lucide-react";
import { requirePermission } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import ModalTrigger from "@/components/Modal";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState, StatusPill, Surface } from "@/components/visual-system";
import { WorkspaceHero } from "@/components/workspace-hero";
import { createCompetitor } from "@/app/actions/competitors";
import { pendingChangeCount } from "@/lib/competitors";

export const dynamic = "force-dynamic";

const TIER_LABEL: Record<number, string> = {
  1: "Tier 1 · critical",
  2: "Tier 2 · important",
  3: "Tier 3 · watch",
};

export default async function CompetitorsPage() {
  await requirePermission("competitors.view");
  const [competitors, pending] = await Promise.all([
    prisma.competitor.findMany({
      orderBy: [{ tier: "asc" }, { name: "asc" }],
      include: {
        _count: { select: { sources: true } },
        changes: { where: { status: "new" }, select: { id: true, materiality: true } },
      },
    }),
    pendingChangeCount(),
  ]);
  const critical = competitors.reduce((sum, competitor) => sum + competitor.changes.filter((change) => change.materiality === "critical").length, 0);
  const sources = competitors.reduce((sum, competitor) => sum + competitor._count.sources, 0);

  return (
    <div className="space-y-6">
      <WorkspaceHero icon={Radar} eyebrow="Market intelligence"
        title="Competitor intelligence"
        description="Monitor the market signals that matter, review material changes and keep your positioning current."
        stats={[
          { label: "Monitored", value: competitors.length, icon: Eye },
          { label: "Sources", value: sources, icon: Globe2 },
          { label: "To review", value: pending, icon: AlertTriangle, tone: pending ? "warning" : "default" },
          { label: "Critical", value: critical, icon: ShieldCheck, tone: critical ? "danger" : "success" },
        ]}
        actions={<ModalTrigger
          label={
            <>
              <Plus className="size-4" />
              Add competitor
            </>
          }
          title="Add competitor"
          buttonClass={buttonVariants({ size: "sm" })}
        >
          <NewCompetitorForm />
        </ModalTrigger>}
      />

      {competitors.length === 0 ? (
        <EmptyState
          icon={Radar}
          title="No competitors yet"
          description="Add a competitor and a few public pages—pricing, products or changelogs—to start watching for material changes."
          action={<ModalTrigger label={<><Plus className="size-4" />Add competitor</>} title="Add competitor"><NewCompetitorForm /></ModalTrigger>}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {competitors.map((c) => {
            const critical = c.changes.filter((x) => x.materiality === "critical").length;
            return (
              <Surface key={c.id} className="group relative overflow-hidden p-5 transition hover:border-primary/35">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-primary/15 bg-primary/10 font-semibold text-primary">{c.name.slice(0, 1).toUpperCase()}</span>
                    <div className="min-w-0"><p className="truncate font-semibold text-foreground">{c.name}</p>
                    {c.website && (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">{c.website.replace(/^https?:\/\//, "")}</p>
                    )}
                    </div>
                  </div>
                  <StatusPill tone={c.tier === 1 ? "danger" : c.tier === 2 ? "info" : "neutral"}>{TIER_LABEL[c.tier]}</StatusPill>
                </div>
                <div className="mt-5 grid grid-cols-2 gap-2 rounded-xl border border-border/70 bg-muted/20 p-3 text-xs text-muted-foreground">
                  <span>
                    {c._count.sources} source{c._count.sources === 1 ? "" : "s"}
                  </span>
                  {c.changes.length > 0 ? (
                    <span className={critical ? "text-red-300" : "text-amber-300"}>
                      {c.changes.length} to review{critical ? ` · ${critical} critical` : ""}
                    </span>
                  ) : (
                    <span className="text-emerald-300/80">Up to date</span>
                  )}
                </div>
                <Link href={`/competitors/${c.id}`} className="mt-4 flex items-center justify-between text-sm font-medium text-primary after:absolute after:inset-0">Open intelligence profile <ArrowUpRight className="size-4" /></Link>
              </Surface>
            );
          })}
        </div>
      )}
    </div>
  );
}

function NewCompetitorForm() {
  return (
    <form action={createCompetitor} className="space-y-3">
      <div>
        <label className="label">Name *</label>
        <input name="name" className="input" required placeholder="e.g. Acme EV" autoFocus />
      </div>
      <div>
        <label className="label">Website</label>
        <input name="website" className="input" placeholder="https://acme-ev.com" />
      </div>
      <div>
        <label className="label">Tier</label>
        <select name="tier" className="input" defaultValue="2">
          <option value="1">Tier 1 · critical</option>
          <option value="2">Tier 2 · important</option>
          <option value="3">Tier 3 · watch</option>
        </select>
      </div>
      <div>
        <label className="label">Notes</label>
        <textarea name="description" className="input" rows={2} placeholder="Positioning, why they matter…" />
      </div>
      <button className="btn-primary w-full">Add competitor</button>
    </form>
  );
}

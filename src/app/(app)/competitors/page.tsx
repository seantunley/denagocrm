import Link from "next/link";
import { Radar, Plus } from "lucide-react";
import { requireOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/page-header";
import ModalTrigger from "@/components/Modal";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState, StatusPill } from "@/components/visual-system";
import { createCompetitor } from "@/app/actions/competitors";
import { pendingChangeCount } from "@/lib/competitors";

export const dynamic = "force-dynamic";

const TIER_LABEL: Record<number, string> = {
  1: "Tier 1 · critical",
  2: "Tier 2 · important",
  3: "Tier 3 · watch",
};

export default async function CompetitorsPage() {
  await requireOwner();
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

  return (
    <div className="space-y-6">
      <PageHeader
        title="Competitor intelligence"
        description={`Monitoring ${competitors.length} competitor${competitors.length === 1 ? "" : "s"} · ${pending} change${pending === 1 ? "" : "s"} awaiting review`}
      >
        <ModalTrigger
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
        </ModalTrigger>
      </PageHeader>

      {competitors.length === 0 ? (
        <EmptyState
          icon={Radar}
          title="No competitors yet"
          description="Add a competitor and a few of their public pages (pricing, product, changelog) to start watching for material changes."
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {competitors.map((c) => {
            const critical = c.changes.filter((x) => x.materiality === "critical").length;
            return (
              <Link key={c.id} href={`/competitors/${c.id}`} className="card group block transition hover:border-orange-500/35">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-foreground group-hover:text-orange-300">{c.name}</p>
                    {c.website && (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">{c.website.replace(/^https?:\/\//, "")}</p>
                    )}
                  </div>
                  <StatusPill tone={c.tier === 1 ? "danger" : c.tier === 2 ? "info" : "neutral"}>{TIER_LABEL[c.tier]}</StatusPill>
                </div>
                <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
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
              </Link>
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

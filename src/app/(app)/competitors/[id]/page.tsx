import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { EntityDetailShell } from "@/components/entity-detail-shell";
import { StatusPill } from "@/components/visual-system";
import ConfirmDelete from "@/components/ConfirmDelete";
import { formatDateTime } from "@/lib/format";
import { addSource, deleteSource, runSourceNow, reviewChange, deleteCompetitor } from "@/app/actions/competitors";

export const dynamic = "force-dynamic";

const MATERIALITY_TONE: Record<string, "danger" | "warning" | "info" | "neutral"> = {
  critical: "danger",
  important: "warning",
  minor: "neutral",
  noise: "neutral",
};

export default async function CompetitorDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;
  const competitor = await prisma.competitor.findUnique({
    where: { id },
    include: {
      sources: { orderBy: { createdAt: "asc" } },
      changes: {
        orderBy: { createdAt: "desc" },
        take: 40,
        include: { source: { select: { label: true } } },
      },
      _count: { select: { snapshots: true } },
    },
  });
  if (!competitor) notFound();

  const pending = competitor.changes.filter((c) => c.status === "new");
  const reviewed = competitor.changes.filter((c) => c.status !== "new");

  return (
    <EntityDetailShell
      backHref="/competitors"
      backLabel="Competitors"
      eyebrow="Competitor intelligence"
      title={competitor.name}
      status={
        <StatusPill tone={competitor.status === "active" ? "success" : "neutral"}>
          {competitor.status === "active" ? "Monitoring" : "Archived"}
        </StatusPill>
      }
      description={competitor.website ?? competitor.description ?? "No website recorded"}
      facts={[
        { label: "Sources", value: competitor.sources.length },
        { label: "Snapshots", value: competitor._count.snapshots },
        { label: "To review", value: pending.length },
        { label: "Tier", value: `T${competitor.tier}` },
      ]}
    >
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Changes feed */}
        <div className="space-y-4 lg:col-span-2">
          <section className="card">
            <h2 className="mb-3 font-semibold">Changes to review ({pending.length})</h2>
            {pending.length === 0 ? (
              <p className="text-sm text-muted-foreground/70">Nothing pending. New material changes appear here after the daily check.</p>
            ) : (
              <ul className="space-y-3">
                {pending.map((c) => (
                  <li key={c.id} className="rounded-xl border border-border bg-background/30 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill tone={MATERIALITY_TONE[c.materiality] ?? "neutral"}>{c.materiality}</StatusPill>
                      {c.category && <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{c.category}</span>}
                      <span className="text-[11px] text-muted-foreground">{c.source.label} · {formatDateTime(c.createdAt)}</span>
                    </div>
                    <p className="mt-1.5 text-sm text-foreground">{c.summary}</p>
                    {(c.evidenceAfter || c.evidenceBefore) && (
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        {c.evidenceBefore && (
                          <div className="rounded-lg bg-red-500/[0.06] p-2">
                            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-red-300/80">Before</p>
                            <p className="whitespace-pre-wrap text-[11px] text-muted-foreground line-clamp-6">{c.evidenceBefore}</p>
                          </div>
                        )}
                        {c.evidenceAfter && (
                          <div className="rounded-lg bg-emerald-500/[0.06] p-2">
                            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-300/80">After</p>
                            <p className="whitespace-pre-wrap text-[11px] text-muted-foreground line-clamp-6">{c.evidenceAfter}</p>
                          </div>
                        )}
                      </div>
                    )}
                    <div className="mt-2 flex gap-2">
                      <form action={reviewChange.bind(null, competitor.id, c.id, "reviewed")}>
                        <button className="btn-secondary btn-sm">Mark reviewed</button>
                      </form>
                      <form action={reviewChange.bind(null, competitor.id, c.id, "dismissed")}>
                        <button className="text-xs text-slate-500 hover:text-red-400">Dismiss as noise</button>
                      </form>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {reviewed.length > 0 && (
            <section className="card">
              <h2 className="mb-3 font-semibold">History</h2>
              <ul className="divide-y divide-border/50">
                {reviewed.map((c) => (
                  <li key={c.id} className="flex items-center gap-2 py-2 text-sm">
                    <StatusPill tone={MATERIALITY_TONE[c.materiality] ?? "neutral"}>{c.materiality}</StatusPill>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{c.summary}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground/70">
                      {c.status} · {formatDateTime(c.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        {/* Sources sidebar */}
        <div className="space-y-4">
          <section className="card">
            <h2 className="mb-3 font-semibold">Watched pages</h2>
            <ul className="space-y-2">
              {competitor.sources.map((s) => (
                <li key={s.id} className="rounded-lg border border-border bg-background/30 p-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{s.label}</p>
                      <a href={s.url} target="_blank" rel="noopener" className="block truncate text-[11px] text-primary hover:underline">
                        {s.url.replace(/^https?:\/\//, "")}
                      </a>
                    </div>
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{s.sourceType}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {s.lastStatus === "error" ? (
                      <span className="text-red-300">⚠ {s.lastError ?? "error"}</span>
                    ) : s.lastCheckedAt ? (
                      <>Checked {formatDateTime(s.lastCheckedAt)}{s.lastChangedAt ? ` · changed ${formatDateTime(s.lastChangedAt)}` : ""}</>
                    ) : (
                      "Never checked"
                    )}
                  </p>
                  <div className="mt-1.5 flex items-center gap-2">
                    <form action={runSourceNow.bind(null, competitor.id, s.id)}>
                      <button className="btn-secondary btn-sm">Check now</button>
                    </form>
                    <ConfirmDelete
                      action={deleteSource.bind(null, competitor.id, s.id)}
                      title={`Stop watching "${s.label}"?`}
                      description="Removes the source and its snapshots. History for this page is lost."
                      trigger="Remove"
                      triggerClass="text-xs text-slate-500 hover:text-red-400"
                    />
                  </div>
                </li>
              ))}
              {competitor.sources.length === 0 && (
                <li className="text-sm text-muted-foreground/70">No pages watched yet — add one below.</li>
              )}
            </ul>

            <form action={addSource.bind(null, competitor.id)} className="mt-4 space-y-2 border-t border-border/60 pt-3">
              <input name="label" className="input" placeholder="Label (e.g. Pricing)" />
              <input name="url" className="input" placeholder="https://competitor.com/pricing" required />
              <select name="sourceType" className="input" defaultValue="pricing">
                <option value="pricing">Pricing</option>
                <option value="product">Product</option>
                <option value="changelog">Changelog</option>
                <option value="blog">Blog / news</option>
                <option value="page">Other page</option>
              </select>
              <button className="btn-primary btn-sm w-full">Add page to watch</button>
            </form>
          </section>

          <section className="card">
            <ConfirmDelete
              action={deleteCompetitor.bind(null, competitor.id)}
              title={`Delete "${competitor.name}"?`}
              description="Moves the competitor and its monitoring to Trash."
              trigger="Delete competitor"
              triggerClass="text-xs text-slate-500 hover:text-red-400"
            />
          </section>
        </div>
      </div>
    </EntityDetailShell>
  );
}

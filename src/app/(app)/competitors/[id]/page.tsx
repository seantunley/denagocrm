import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { EntityDetailShell } from "@/components/entity-detail-shell";
import { StatusPill } from "@/components/visual-system";
import ConfirmDelete from "@/components/ConfirmDelete";
import { formatDateTime } from "@/lib/format";
import {
  addSource,
  deleteSource,
  runSourceNow,
  reviewChange,
  deleteCompetitor,
  discoverSourcesNow,
  researchNow,
} from "@/app/actions/competitors";

export const dynamic = "force-dynamic";

const MATERIALITY_TONE: Record<string, "danger" | "warning" | "info" | "neutral"> = {
  critical: "danger",
  important: "warning",
  minor: "neutral",
  noise: "neutral",
};

/** Render the citation chips a web-search brief came back with. */
function BriefCitations({ citations }: { citations: unknown }) {
  if (!Array.isArray(citations) || citations.length === 0) return null;
  const cites = citations
    .filter((c): c is { title?: string; url: string } => Boolean(c) && typeof (c as { url?: unknown }).url === "string")
    .slice(0, 8);
  if (cites.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {cites.map((c, i) => (
        <a
          key={i}
          href={c.url}
          target="_blank"
          rel="noopener"
          className="rounded-full border border-border bg-background/50 px-2 py-0.5 text-[10px] text-primary hover:underline"
          title={c.url}
        >
          {(c.title || c.url).replace(/^https?:\/\//, "").slice(0, 40)}
        </a>
      ))}
    </div>
  );
}

export default async function CompetitorDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("competitors.view");
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
      briefs: { orderBy: { createdAt: "desc" }, take: 12 },
      _count: { select: { snapshots: true } },
    },
  });
  if (!competitor) notFound();

  const pending = competitor.changes.filter((c) => c.status === "new");
  const reviewed = competitor.changes.filter((c) => c.status !== "new");
  const latestBrief = competitor.briefs.find((b) => b.kind === "research") ?? null;

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
        { label: "Briefs", value: competitor.briefs.length },
        { label: "To review", value: pending.length },
        {
          label: "Last researched",
          value: competitor.lastResearchedAt ? formatDateTime(competitor.lastResearchedAt) : "Never",
        },
      ]}
    >
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Changes feed */}
        <div className="space-y-4 lg:col-span-2">
          {/* AI intelligence */}
          <section className="card border-primary/20 bg-primary/[0.03]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-semibold">AI intelligence</h2>
                <p className="text-xs text-muted-foreground">
                  A strong model researches this competitor on the web; the daily check watches the pages between briefs.
                </p>
              </div>
              <div className="flex gap-2">
                <form action={discoverSourcesNow.bind(null, competitor.id)}>
                  <button className="btn-secondary btn-sm">Discover sources</button>
                </form>
                <form action={researchNow.bind(null, competitor.id)}>
                  <button className="btn-primary btn-sm">Run research</button>
                </form>
              </div>
            </div>

            {latestBrief ? (
              <article className="mt-3 rounded-xl border border-border bg-background/40 p-3">
                {latestBrief.headline && <p className="text-sm font-semibold text-foreground">{latestBrief.headline}</p>}
                <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground">
                  {latestBrief.body}
                </p>
                <BriefCitations citations={latestBrief.citations} />
                <p className="mt-2 text-[11px] text-muted-foreground/60">
                  {latestBrief.model ?? "AI"} · {formatDateTime(latestBrief.createdAt)}
                </p>
              </article>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground/70">
                No brief yet. Use <strong>Discover sources</strong> to find pages and socials automatically, then{" "}
                <strong>Run research</strong> for the first intelligence brief.
              </p>
            )}

            {competitor.briefs.length > 1 && (
              <details className="mt-3">
                <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
                  Earlier briefs ({competitor.briefs.length - 1})
                </summary>
                <ul className="mt-2 space-y-2">
                  {competitor.briefs
                    .filter((b) => b.id !== latestBrief?.id)
                    .map((b) => (
                      <li key={b.id} className="rounded-lg border border-border/60 bg-background/30 p-2.5">
                        <div className="flex items-center gap-2">
                          <StatusPill tone={b.kind === "discovery" ? "info" : "neutral"}>{b.kind}</StatusPill>
                          <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                            {b.headline ?? b.body.slice(0, 80)}
                          </span>
                          <span className="shrink-0 text-[11px] text-muted-foreground/60">{formatDateTime(b.createdAt)}</span>
                        </div>
                        {b.kind !== "discovery" && (
                          <p className="mt-1 whitespace-pre-wrap text-[12px] text-muted-foreground line-clamp-6">{b.body}</p>
                        )}
                        <BriefCitations citations={b.citations} />
                      </li>
                    ))}
                </ul>
              </details>
            )}
          </section>

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
                <option value="news">News</option>
                <option value="blog">Blog</option>
                <option value="facebook">Facebook</option>
                <option value="instagram">Instagram</option>
                <option value="linkedin">LinkedIn</option>
                <option value="youtube">YouTube</option>
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

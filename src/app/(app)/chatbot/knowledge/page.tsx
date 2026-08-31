import Link from "next/link";
import { BookOpenCheck, Clock3, Database, FileCheck2, Library, Search, SlidersHorizontal } from "lucide-react";
import { requireOwner } from "@/lib/auth";
import { actingTenantId } from "@/lib/actingTenant";
import { prisma } from "@/lib/db";
import { getBotKnowledgeEntries, knowledgeIsCurrent, type BotKnowledgeStatus } from "@/lib/botKnowledge";
import { addBotKnowledge, deleteBotKnowledge, setBotKnowledgeStatus, updateBotKnowledge } from "@/app/actions/bot";
import { StatusPill, Surface } from "@/components/visual-system";
import { WorkspaceHero } from "@/components/workspace-hero";

type Props = { searchParams: Promise<{ q?: string; status?: string; source?: string; sort?: string }> };

const statusTone = (entry: { status: BotKnowledgeStatus }, current: boolean) => current ? "success" : entry.status === "draft" ? "warning" : "neutral";
const dateValue = (value?: string) => value?.slice(0, 10) ?? "";

export default async function BotKnowledgePage({ searchParams }: Props) {
  await requireOwner();
  const tenantId = await actingTenantId();
  const [params, entries, libraryDocuments] = await Promise.all([
    searchParams,
    getBotKnowledgeEntries(),
    prisma.libraryDocument.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { updatedAt: "desc" }, take: 200 }),
  ]);
  const q = (params.q ?? "").trim().toLocaleLowerCase("en-ZA");
  const status = ["draft", "approved", "expired"].includes(params.status ?? "") ? params.status : "all";
  const source = ["manual", "library"].includes(params.source ?? "") ? params.source : "all";
  const sort = ["updated", "title", "status"].includes(params.sort ?? "") ? params.sort : "updated";
  const filtered = entries
    .filter((entry) => {
      const effectiveStatus = entry.status === "approved" && !knowledgeIsCurrent(entry) ? "expired" : entry.status;
      return (status === "all" || effectiveStatus === status)
        && (source === "all" || entry.sourceType === source)
        && (!q || `${entry.title}\n${entry.content}\n${entry.sourceLabel ?? ""}`.toLocaleLowerCase("en-ZA").includes(q));
    })
    .sort((a, b) => sort === "title"
      ? a.title.localeCompare(b.title, "en-ZA")
      : sort === "status"
        ? a.status.localeCompare(b.status) || a.title.localeCompare(b.title, "en-ZA")
        : b.updatedAt.localeCompare(a.updatedAt));
  const approved = entries.filter((entry) => knowledgeIsCurrent(entry)).length;
  const drafts = entries.filter((entry) => entry.status === "draft").length;
  const expired = entries.filter((entry) => entry.status === "expired" || (entry.status === "approved" && !knowledgeIsCurrent(entry))).length;
  const sourced = entries.filter((entry) => entry.sourceType === "library").length;

  return (
    <div className="space-y-5">
      <WorkspaceHero
        icon={BookOpenCheck}
        eyebrow="Grounded AI"
        title="Knowledge workspace"
        description="Maintain the reviewed facts, policies and document excerpts the chatbot may cite. New and edited entries remain private drafts until separately approved."
        stats={[
          { label: "Approved & current", value: approved, icon: FileCheck2, tone: "success" },
          { label: "Awaiting review", value: drafts, icon: Clock3 },
          { label: "Expired", value: expired, icon: Database },
          { label: "Library sourced", value: sourced, icon: Library },
        ]}
        actions={<Link href="/chatbot/preview" className="btn-primary btn-sm">Test an AI answer</Link>}
      />

      <Surface className="p-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <form className="grid min-w-0 flex-1 gap-2 sm:grid-cols-[minmax(14rem,1fr)_9rem_9rem_10rem_auto]" action="/chatbot/knowledge">
            <div><label className="label" htmlFor="knowledge-search">Search</label><div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><input id="knowledge-search" name="q" className="input pl-9" defaultValue={params.q ?? ""} placeholder="Warranty, delivery, finance…" /></div></div>
            <div><label className="label" htmlFor="knowledge-status">Status</label><select id="knowledge-status" name="status" className="input" defaultValue={status}><option value="all">All</option><option value="draft">Draft</option><option value="approved">Approved</option><option value="expired">Expired</option></select></div>
            <div><label className="label" htmlFor="knowledge-source">Source</label><select id="knowledge-source" name="source" className="input" defaultValue={source}><option value="all">All</option><option value="manual">Manual</option><option value="library">Library</option></select></div>
            <div><label className="label" htmlFor="knowledge-sort">Sort</label><select id="knowledge-sort" name="sort" className="input" defaultValue={sort}><option value="updated">Recently updated</option><option value="title">Title A–Z</option><option value="status">Status</option></select></div>
            <button className="btn-secondary btn-sm self-end"><SlidersHorizontal className="size-3.5" />Apply</button>
          </form>
          <span className="text-xs text-muted-foreground">{filtered.length} of {entries.length} entries</span>
        </div>
      </Surface>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_24rem] xl:items-start">
        <div className="space-y-3">
          {filtered.length === 0 ? <Surface className="p-8 text-center text-sm text-muted-foreground"><p>No knowledge entries match this view.</p><Link href="/chatbot/knowledge" className="mt-3 inline-flex text-xs font-medium text-primary hover:underline">Clear filters</Link></Surface> : null}
          {filtered.map((entry) => {
            const current = knowledgeIsCurrent(entry);
            const statusLabel = entry.status === "approved" && !current ? "Expired by date" : entry.status;
            return (
              <Surface key={entry.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-semibold">{entry.title}</h2><StatusPill tone={statusTone(entry, current)}>{statusLabel}</StatusPill><StatusPill tone="neutral">{entry.sourceType === "library" ? "Library" : "Manual"}</StatusPill></div>
                    <p className="mt-1 text-[11px] text-muted-foreground">{entry.sourceLabel ? `Source: ${entry.sourceLabel}` : "Manual source"}{entry.approvedBy ? ` · approved by ${entry.approvedBy}` : ""} · updated {new Date(entry.updatedAt).toLocaleDateString("en-ZA")}</p>
                  </div>
                  <form action={deleteBotKnowledge.bind(null, entry.id)}><button className="btn-secondary btn-sm text-red-300" aria-label={`Delete ${entry.title}`}>Delete</button></form>
                </div>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{entry.content}</p>
                {(entry.validFrom || entry.validUntil) ? <p className="mt-2 text-[11px] text-muted-foreground">Validity: {entry.validFrom ? new Date(entry.validFrom).toLocaleDateString("en-ZA") : "open"} – {entry.validUntil ? new Date(entry.validUntil).toLocaleDateString("en-ZA") : "open"}</p> : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  {entry.status !== "approved" ? <form action={setBotKnowledgeStatus.bind(null, entry.id, "approved")}><button className="btn-primary btn-sm">Approve</button></form> : null}
                  {entry.status === "approved" ? <form action={setBotKnowledgeStatus.bind(null, entry.id, "expired")}><button className="btn-secondary btn-sm">Expire</button></form> : null}
                  {entry.status === "expired" ? <form action={setBotKnowledgeStatus.bind(null, entry.id, "draft")}><button className="btn-secondary btn-sm">Return to draft</button></form> : null}
                  {current ? <Link href={`/chatbot/preview?q=${encodeURIComponent(entry.title)}`} className="btn-secondary btn-sm">Preview AI use</Link> : null}
                </div>
                <details className="mt-3 rounded-lg border border-border bg-muted/25">
                  <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium [&::-webkit-details-marker]:hidden">Edit entry</summary>
                  <form action={updateBotKnowledge.bind(null, entry.id)} className="space-y-2 border-t border-border p-3">
                    <div><label className="label" htmlFor={`knowledge-title-${entry.id}`}>Title</label><input id={`knowledge-title-${entry.id}`} name="title" className="input" required maxLength={180} defaultValue={entry.title} /></div>
                    <div><label className="label" htmlFor={`knowledge-content-${entry.id}`}>Approved excerpt or fact</label><textarea id={`knowledge-content-${entry.id}`} name="content" className="input" rows={6} required maxLength={5000} defaultValue={entry.content} /></div>
                    <div><label className="label" htmlFor={`knowledge-source-${entry.id}`}>Library source</label><select id={`knowledge-source-${entry.id}`} name="sourceDocumentId" className="input" defaultValue={entry.sourceDocumentId ?? ""}><option value="">Manual / no document</option>{libraryDocuments.map((doc) => <option key={doc.id} value={doc.id}>{doc.name}</option>)}</select></div>
                    <div className="grid grid-cols-2 gap-2"><div><label className="label">Valid from</label><input type="date" name="validFrom" className="input" defaultValue={dateValue(entry.validFrom)} /></div><div><label className="label">Valid until</label><input type="date" name="validUntil" className="input" defaultValue={dateValue(entry.validUntil)} /></div></div>
                    <p className="text-[10px] text-amber-300">Saving an edit returns this entry to Draft so changed customer-facing facts require fresh approval.</p>
                    <button className="btn-secondary btn-sm">Save as draft</button>
                  </form>
                </details>
              </Surface>
            );
          })}
        </div>

        <Surface className="p-5 xl:sticky xl:top-5">
          <h2 className="text-sm font-semibold">Add knowledge draft</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">Paste only precise, customer-safe facts. Library files provide provenance; their contents are never trusted or imported automatically.</p>
          <form action={addBotKnowledge} className="mt-4 space-y-3">
            <div><label className="label">Title</label><input name="title" className="input" required maxLength={180} placeholder="Warranty coverage — batteries" /></div>
            <div><label className="label">Approved excerpt or fact</label><textarea name="content" className="input" rows={7} required maxLength={5000} placeholder="The exact source-of-truth text the assistant may rely on after approval." /></div>
            <div><label className="label">Library source (optional)</label><select name="sourceDocumentId" className="input"><option value="">Manual / no document</option>{libraryDocuments.map((doc) => <option key={doc.id} value={doc.id}>{doc.name}</option>)}</select></div>
            <div className="grid grid-cols-2 gap-2"><div><label className="label">Valid from</label><input type="date" name="validFrom" className="input" /></div><div><label className="label">Valid until</label><input type="date" name="validUntil" className="input" /></div></div>
            <p className="text-[10px] leading-4 text-muted-foreground">New entries are always Draft. Approval is a separate owner action.</p>
            <button className="btn-primary btn-sm">Add draft</button>
          </form>
        </Surface>
      </div>
    </div>
  );
}

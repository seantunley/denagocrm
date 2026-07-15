import Link from "next/link";
import { LifeBuoy, Plus, Inbox } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireAnyPermission, getAccessibleContactIds, hasPermission } from "@/lib/permissions";
import { listTickets, folderCounts, listMailboxes, listTags, type TicketFilters } from "@/lib/helpdesk";
import { FOLDERS, statusMeta, priorityMeta } from "@/lib/helpdesk-constants";
import { contactName, formatDateTime } from "@/lib/format";
import ModalTrigger from "@/components/Modal";
import { NewTicketForm } from "@/components/helpdesk/NewTicketForm";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState, StatusPill } from "@/components/visual-system";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

type SP = { folder?: string; mailbox?: string; assignee?: string; tag?: string; q?: string; type?: string };

function qs(base: SP, patch: Partial<SP>): string {
  const merged = { ...base, ...patch };
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) if (v) params.set(k, v);
  const s = params.toString();
  return s ? `/cases?${s}` : "/cases";
}

export default async function CasesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireAnyPermission("cases.view_all", "cases.view_owned");
  const sp = await searchParams;
  const filters: TicketFilters = {
    folder: (sp.folder as TicketFilters["folder"]) ?? "open",
    mailboxSlug: sp.mailbox ?? null,
    assignee: sp.assignee ?? null,
    tag: sp.tag ?? null,
    q: sp.q ?? null,
    type: sp.type ?? null,
  };

  const [tickets, counts, mailboxes, tags, canCreate] = await Promise.all([
    listTickets(user, filters),
    folderCounts(user, filters),
    listMailboxes(),
    listTags(),
    hasPermission(user, "cases.create"),
  ]);

  const contactIds = canCreate ? await getAccessibleContactIds(user) : [];
  const newTicketContacts = canCreate
    ? await prisma.contact.findMany({
        where: contactIds === null ? {} : { id: { in: contactIds } },
        orderBy: { firstName: "asc" },
        take: 500,
        select: { id: true, firstName: true, lastName: true, company: true, isCompany: true },
      })
    : [];

  const activeFolder = filters.folder ?? "open";

  return (
    <div className="space-y-5">
      <PageHeader title="Help desk" description="Customer support tickets across every mailbox.">
        {canCreate && (
          <ModalTrigger
            label={<><Plus className="size-4" />New ticket</>}
            title="New ticket"
            buttonClass={buttonVariants({ size: "sm" })}
          >
            <NewTicketForm
              contacts={newTicketContacts.map((c) => ({ id: c.id, label: contactName(c) }))}
              mailboxes={mailboxes.map((m) => ({ id: m.id, label: m.name }))}
            />
          </ModalTrigger>
        )}
      </PageHeader>

      <div className="grid gap-5 lg:grid-cols-[15rem_minmax(0,1fr)]">
        {/* Folder / mailbox sidebar */}
        <aside className="space-y-5 lg:sticky lg:top-4 lg:self-start">
          <nav className="card space-y-0.5 p-2">
            {FOLDERS.map((f) => {
              const count = (counts as Record<string, number>)[f.key];
              const active = activeFolder === f.key;
              return (
                <Link
                  key={f.key}
                  href={qs(sp, { folder: f.key })}
                  className={cn(
                    "flex items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors",
                    active ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
                  )}
                >
                  <span className="flex items-center gap-2"><Inbox className="size-4" />{f.label}</span>
                  {typeof count === "number" && count > 0 && <span className="text-xs tabular-nums">{count}</span>}
                </Link>
              );
            })}
          </nav>

          {mailboxes.length > 0 && (
            <div className="card space-y-0.5 p-2">
              <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Mailboxes</p>
              <Link href={qs(sp, { mailbox: "" })} className={cn("block rounded-lg px-3 py-2 text-sm", !filters.mailboxSlug ? "bg-white/[0.05] font-medium" : "text-muted-foreground hover:bg-white/[0.04]")}>All mailboxes</Link>
              {mailboxes.map((m) => (
                <Link key={m.id} href={qs(sp, { mailbox: m.slug })} className={cn("flex items-center gap-2 rounded-lg px-3 py-2 text-sm", filters.mailboxSlug === m.slug ? "bg-white/[0.05] font-medium" : "text-muted-foreground hover:bg-white/[0.04]")}>
                  <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: m.color }} />
                  {m.name}
                </Link>
              ))}
            </div>
          )}

          {tags.length > 0 && (
            <div className="card p-3">
              <p className="pb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Tags</p>
              <div className="flex flex-wrap gap-1.5">
                {tags.map((t) => (
                  <Link key={t.id} href={qs(sp, { tag: filters.tag === t.slug ? "" : t.slug })} className={cn("rounded-full border px-2 py-0.5 text-xs", filters.tag === t.slug ? "border-primary/40 bg-primary/10 text-primary" : "border-white/10 text-muted-foreground hover:border-white/20")}>
                    {t.name}
                  </Link>
                ))}
              </div>
            </div>
          )}
        </aside>

        {/* Ticket list */}
        <div className="min-w-0 space-y-3">
          <form className="flex gap-2" action="/cases">
            {filters.folder && <input type="hidden" name="folder" value={filters.folder} />}
            {filters.mailboxSlug && <input type="hidden" name="mailbox" value={filters.mailboxSlug} />}
            <input name="q" defaultValue={sp.q ?? ""} placeholder="Search tickets…" className="input flex-1" />
            <button className={buttonVariants({ variant: "outline", size: "sm" })}>Search</button>
          </form>

          {tickets.length === 0 ? (
            <EmptyState icon={LifeBuoy} title="No tickets here" description="Nothing matches this folder or filter yet." />
          ) : (
            <div className="card divide-y divide-white/[0.06] p-0">
              {tickets.map((t) => {
                const sm = statusMeta(t.status);
                const pm = priorityMeta(t.priority);
                const waitingOnUs = t.lastReplyBy === "customer";
                return (
                  <Link key={t.id} href={`/cases/${t.id}`} className="flex flex-col gap-1.5 px-4 py-3 transition-colors hover:bg-white/[0.03] sm:flex-row sm:items-center sm:gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        {Number(t.unread) > 0 && <span className="size-2 shrink-0 rounded-full bg-primary" title={`${Number(t.unread)} unread`} />}
                        <span className={cn("truncate text-sm", Number(t.unread) > 0 ? "font-semibold" : "font-medium")}>{t.subject}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">C-{t.number.toString()}</span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="truncate">{t.contactName}{t.vehicleModel ? ` · ${t.vehicleModel}` : ""}</span>
                        {t.tags.map((tag) => (
                          <span key={tag.name} className="rounded-full px-1.5 py-0.5 text-[10px]" style={{ backgroundColor: `${tag.color}22`, color: tag.color }}>{tag.name}</span>
                        ))}
                      </div>
                      {t.lastPreview && <p className="mt-1 truncate text-xs text-muted-foreground/80">{t.lastPreview}</p>}
                    </div>
                    <div className="flex shrink-0 items-center gap-2 sm:w-auto sm:flex-col sm:items-end sm:gap-1">
                      <div className="flex items-center gap-1.5">
                        {pm.value !== "normal" && <StatusPill tone={pm.tone}>{pm.label}</StatusPill>}
                        <StatusPill tone={sm.tone}>{sm.label}</StatusPill>
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        {waitingOnUs && <span className="font-medium text-amber-400">Awaiting reply</span>}
                        <span>{t.assigneeName ?? "Unassigned"}</span>
                        <span>{formatDateTime(t.lastMessageAt ?? t.updatedAt)}</span>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import Link from "next/link";
import {
  Archive,
  ArrowRight,
  CircleUserRound,
  Clock3,
  Inbox,
  Layers3,
  LifeBuoy,
  MailOpen,
  MessageCircleReply,
  Plus,
  Search,
  Tag,
  UserRoundCheck,
  UserRoundX,
  type LucideIcon,
} from "lucide-react";
import ModalTrigger from "@/components/Modal";
import { NewTicketForm } from "@/components/helpdesk/NewTicketForm";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  EmptyState,
  StatusPill,
  Surface,
  WorkspaceToolbar,
} from "@/components/visual-system";
import { WorkspaceHero } from "@/components/workspace-hero";
import { prisma } from "@/lib/db";
import { contactName, formatDateTime } from "@/lib/format";
import {
  FOLDERS,
  TICKET_TYPES,
  priorityMeta,
  statusMeta,
  type Folder,
} from "@/lib/helpdesk-constants";
import {
  folderCounts,
  listMailboxes,
  listTags,
  listTickets,
  type TicketFilters,
  type TicketListRow,
} from "@/lib/helpdesk";
import {
  getAccessibleContactIds,
  hasPermission,
  requireAnyPermission,
} from "@/lib/permissions";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { cn } from "@/lib/utils";
import RecordContextMenu from "@/components/RecordContextMenu";
import {
  DesktopOnly,
  MobileOnly,
  MobileSection,
  MobileSegmentNav,
  MobileStatPair,
  MobileTaskCard,
  MobileTaskList,
  MobileWorkspaceHeader,
} from "@/components/mobile-workspace";

export const dynamic = "force-dynamic";

type SP = {
  folder?: string;
  mailbox?: string;
  assignee?: string;
  tag?: string;
  q?: string;
  type?: string;
};

const FOLDER_ICONS: Record<Folder, LucideIcon> = {
  unassigned: UserRoundX,
  mine: UserRoundCheck,
  open: Inbox,
  pending: Clock3,
  closed: Archive,
  all: Layers3,
};

function qs(base: SP, patch: Partial<SP>): string {
  const merged = { ...base, ...patch };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) {
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return query ? `/cases?${query}` : "/cases";
}

function titleCase(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

export default async function CasesPage({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
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

  const [tickets, counts, mailboxes, tags, canCreate, automotiveOn] = await Promise.all([
    listTickets(user, filters),
    folderCounts(user, filters),
    listMailboxes(),
    listTags(),
    hasPermission(user, "cases.create"),
    isModuleEnabled("automotive"),
  ]);

  const contactIds = canCreate ? await getAccessibleContactIds(user) : [];
  const newTicketContacts = canCreate
    ? await prisma.contact.findMany({
        where: contactIds === null ? {} : { id: { in: contactIds } },
        orderBy: { firstName: "asc" },
        take: 500,
        select: {
          id: true,
          firstName: true,
          lastName: true,
          company: true,
          isCompany: true,
        },
      })
    : [];

  const activeFolder = filters.folder ?? "open";
  const awaitingReply = tickets.filter((ticket) => ticket.lastReplyBy === "customer").length;
  const unread = tickets.reduce((total, ticket) => total + Number(ticket.unread), 0);
  const activeFilterCount = [
    filters.mailboxSlug,
    filters.assignee,
    filters.tag,
    filters.q,
    filters.type,
  ].filter(Boolean).length;
  const folderLabel = FOLDERS.find((folder) => folder.key === activeFolder)?.label ?? "Cases";

  return (
    <>
      <MobileOnly className="space-y-4">
        <MobileWorkspaceHeader
          title="Help desk"
          description="Triage replies and move customer cases forward."
          action={canCreate ? (
            <ModalTrigger label={<><Plus className="size-4" />New</>} title="New customer case" buttonClass={buttonVariants({ size: "sm" })}>
              <NewTicketForm
                contacts={newTicketContacts.map((contact) => ({ id: contact.id, label: contactName(contact) }))}
                mailboxes={mailboxes.map((mailbox) => ({ id: mailbox.id, label: mailbox.name }))}
              />
            </ModalTrigger>
          ) : undefined}
        />
        <MobileStatPair items={[
          { label: "Open", value: counts.open },
          { label: "Awaiting you", value: awaitingReply, tone: awaitingReply > 0 ? "attention" : "default" },
        ]} />
        <MobileSegmentNav items={FOLDERS.slice(0, 5).map((folder) => ({
          label: folder.label,
          href: qs(sp, { folder: folder.key }),
          active: activeFolder === folder.key,
          count: folder.key === "all" ? counts.open + counts.pending + counts.closed : counts[folder.key],
        }))} />
        <form className="flex gap-2" action="/cases" role="search">
          {filters.folder && <input type="hidden" name="folder" value={filters.folder} />}
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input name="q" defaultValue={sp.q ?? ""} placeholder="Find a case…" className="pl-9" />
          </div>
          <button className={buttonVariants({ variant: "secondary" })}>Find</button>
        </form>
        <MobileSection title={folderLabel} detail={`${tickets.length} case${tickets.length === 1 ? "" : "s"}`}>
          {tickets.length === 0 ? (
            <EmptyState icon={activeFilterCount > 0 ? Search : LifeBuoy} title={activeFilterCount > 0 ? "No matching cases" : "This queue is clear"} description="There is nothing waiting in this view." />
          ) : (
            <MobileTaskList>
              {tickets.map((ticket) => {
                const status = statusMeta(ticket.status);
                return (
                  <MobileTaskCard
                    key={ticket.id}
                    icon={LifeBuoy}
                    title={ticket.subject}
                    detail={`C-${ticket.number} · ${ticket.contactName}`}
                    meta={`${ticket.lastReplyBy === "customer" ? "Customer replied · " : ""}${formatDateTime(ticket.lastMessageAt ?? ticket.updatedAt)}`}
                    aside={<StatusPill tone={status.tone}>{status.label}</StatusPill>}
                    href={`/cases/${ticket.id}`}
                  />
                );
              })}
            </MobileTaskList>
          )}
        </MobileSection>
      </MobileOnly>

      <DesktopOnly className="space-y-6">
      <WorkspaceHero
        icon={LifeBuoy}
        eyebrow="Customer care operations"
        title="Help desk"
        description="Triage customer questions, take ownership and resolve every service or ownership concern from one queue."
        stats={[
          { label: "Open", value: counts.open, detail: "Active customer cases", icon: Inbox, tone: "primary" },
          { label: "Awaiting reply", value: awaitingReply, detail: "Customer spoke last", icon: MessageCircleReply, tone: awaitingReply > 0 ? "warning" : "default" },
          { label: "Unassigned", value: counts.unassigned, detail: "Needs an owner", icon: UserRoundX, tone: counts.unassigned > 0 ? "danger" : "default" },
          { label: "Unread", value: unread, detail: `In ${folderLabel.toLowerCase()}`, icon: MailOpen },
        ]}
        actions={canCreate ? (
          <ModalTrigger
            label={
              <>
                <Plus className="size-4" />
                New case
              </>
            }
            title="New customer case"
            buttonClass={buttonVariants({ size: "sm" })}
          >
            <NewTicketForm
              contacts={newTicketContacts.map((contact) => ({
                id: contact.id,
                label: contactName(contact),
              }))}
              mailboxes={mailboxes.map((mailbox) => ({
                id: mailbox.id,
                label: mailbox.name,
              }))}
            />
          </ModalTrigger>
        ) : undefined}
      />

      <div className="grid gap-5 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          <Surface className="p-2">
            <p className="px-3 pb-2 pt-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Work queues
            </p>
            <nav className="grid grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-1" aria-label="Case queues">
              {FOLDERS.map((folder) => {
                const count = folder.key === "all"
                  ? counts.open + counts.pending + counts.closed
                  : counts[folder.key];
                const active = activeFolder === folder.key;
                const Icon = FOLDER_ICONS[folder.key];
                return (
                  <Link
                    key={folder.key}
                    href={qs(sp, { folder: folder.key })}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex min-w-0 items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm transition-colors",
                      active
                        ? "bg-primary/10 font-medium text-primary"
                        : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="truncate">{folder.label}</span>
                    <span className={cn(
                      "ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
                      active ? "bg-primary/15 text-primary" : "bg-muted/60 text-muted-foreground",
                    )}>
                      {count}
                    </span>
                  </Link>
                );
              })}
            </nav>
          </Surface>

          {mailboxes.length > 0 && (
            <Surface className="p-2">
              <p className="px-3 pb-2 pt-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Mailboxes
              </p>
              <div className="space-y-0.5">
                <Link
                  href={qs(sp, { mailbox: "" })}
                  className={cn(
                    "flex items-center gap-2 rounded-xl px-3 py-2 text-sm transition-colors",
                    !filters.mailboxSlug
                      ? "bg-white/[0.05] font-medium text-foreground"
                      : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
                  )}
                >
                  <span className="size-2.5 rounded-full border border-border bg-muted" />
                  All mailboxes
                </Link>
                {mailboxes.map((mailbox) => (
                  <Link
                    key={mailbox.id}
                    href={qs(sp, { mailbox: mailbox.slug })}
                    className={cn(
                      "flex items-center gap-2 rounded-xl px-3 py-2 text-sm transition-colors",
                      filters.mailboxSlug === mailbox.slug
                        ? "bg-white/[0.05] font-medium text-foreground"
                        : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
                    )}
                  >
                    <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: mailbox.color }} />
                    <span className="truncate">{mailbox.name}</span>
                  </Link>
                ))}
              </div>
            </Surface>
          )}

          {tags.length > 0 && (
            <Surface className="p-4">
              <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                <Tag className="size-3.5" />
                Tags
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {tags.map((tag) => (
                  <Link
                    key={tag.id}
                    href={qs(sp, { tag: filters.tag === tag.slug ? "" : tag.slug })}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-xs transition-colors",
                      filters.tag === tag.slug
                        ? "border-primary/40 bg-primary/10 text-primary"
                        : "border-border bg-background/30 text-muted-foreground hover:border-white/20 hover:text-foreground",
                    )}
                  >
                    {tag.name}
                  </Link>
                ))}
              </div>
            </Surface>
          )}
        </aside>

        <main className="min-w-0 space-y-4">
          <WorkspaceToolbar>
            <form className="flex flex-col gap-2 sm:flex-row" action="/cases" role="search">
              {filters.folder && <input type="hidden" name="folder" value={filters.folder} />}
              {filters.mailboxSlug && <input type="hidden" name="mailbox" value={filters.mailboxSlug} />}
              {filters.assignee && <input type="hidden" name="assignee" value={filters.assignee} />}
              {filters.tag && <input type="hidden" name="tag" value={filters.tag} />}
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  name="q"
                  defaultValue={sp.q ?? ""}
                  placeholder="Search subject, description or case number"
                  className="h-10 rounded-xl bg-background/50 pl-9"
                />
              </div>
              <select name="type" defaultValue={filters.type ?? ""} className="input h-10 rounded-xl bg-background/50 sm:w-40">
                <option value="">All types</option>
                {TICKET_TYPES.map((ticketType) => (
                  <option key={ticketType} value={ticketType}>{titleCase(ticketType)}</option>
                ))}
              </select>
              <button className={buttonVariants({ variant: "secondary" })}>Filter</button>
              {activeFilterCount > 0 && (
                <Link href={qs({ folder: activeFolder }, {})} className={buttonVariants({ variant: "ghost" })}>
                  Clear
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px]">{activeFilterCount}</span>
                </Link>
              )}
            </form>
          </WorkspaceToolbar>

          <div className="flex items-center justify-between gap-4 px-1">
            <div>
              <h2 className="font-semibold tracking-tight text-foreground">{folderLabel}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {tickets.length} case{tickets.length === 1 ? "" : "s"} in this view
              </p>
            </div>
            {awaitingReply > 0 && (
              <StatusPill tone="warning">{awaitingReply} awaiting reply</StatusPill>
            )}
          </div>

          {tickets.length === 0 ? (
            <EmptyState
              icon={activeFilterCount > 0 ? Search : LifeBuoy}
              title={activeFilterCount > 0 ? "No matching customer cases" : "This queue is clear"}
              description={
                activeFilterCount > 0
                  ? "Try a broader search or clear one of the active mailbox, tag or type filters."
                  : "There are no customer cases in this queue right now."
              }
              action={activeFilterCount > 0 ? (
                <Link href={qs({ folder: activeFolder }, {})} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  Clear filters
                </Link>
              ) : undefined}
            />
          ) : (
            <Surface className="divide-y divide-border/70">
              {tickets.map((ticket) => <TicketRow key={ticket.id} ticket={ticket} automotiveOn={automotiveOn} />)}
            </Surface>
          )}
        </main>
      </div>
      </DesktopOnly>
    </>
  );
}

function TicketRow({ ticket, automotiveOn }: { ticket: TicketListRow; automotiveOn: boolean }) {
  const status = statusMeta(ticket.status);
  const priority = priorityMeta(ticket.priority);
  const waitingOnUs = ticket.lastReplyBy === "customer";
  const unread = Number(ticket.unread);

  return (
    <RecordContextMenu
      label={`C-${ticket.number.toString()} · ${ticket.subject}`}
      href={`/cases/${ticket.id}`}
      actions={[{ label: "Open customer", href: `/contacts/${ticket.contactId}`, icon: "contact" }]}
    >
    <Link
      href={`/cases/${ticket.id}`}
      className="group relative block overflow-hidden px-4 py-4 transition-colors hover:bg-white/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50 sm:px-5"
    >
      {waitingOnUs && <span className="absolute inset-y-4 left-0 w-0.5 rounded-full bg-amber-400" />}
      <div className="flex items-start gap-3.5">
        <span className={cn(
          "relative grid size-10 shrink-0 place-items-center rounded-xl border",
          unread > 0
            ? "border-primary/25 bg-primary/10 text-primary"
            : "border-border bg-muted/40 text-muted-foreground",
        )}>
          <LifeBuoy className="size-[18px]" />
          {unread > 0 && (
            <span className="absolute -right-1.5 -top-1.5 grid min-w-5 place-items-center rounded-full border-2 border-card bg-primary px-1 text-[9px] font-bold leading-4 text-primary-foreground">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <h3 className={cn(
                  "truncate text-sm leading-5 text-foreground transition-colors group-hover:text-primary",
                  unread > 0 ? "font-semibold" : "font-medium",
                )}>
                  {ticket.subject}
                </h3>
                <span className="shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground">
                  C-{ticket.number.toString()}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <CircleUserRound className="size-3.5 shrink-0" />
                  <span className="truncate">{ticket.contactName}</span>
                </span>
                {automotiveOn && ticket.vehicleModel && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{ticket.vehicleModel}</span>
                  </>
                )}
                <span aria-hidden="true">·</span>
                <span>{titleCase(ticket.type)}</span>
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              {priority.value !== "normal" && <StatusPill tone={priority.tone}>{priority.label}</StatusPill>}
              <StatusPill tone={status.tone}>{status.label}</StatusPill>
            </div>
          </div>

          {ticket.lastPreview && (
            <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground/85 sm:line-clamp-1">
              {ticket.lastPreview}
            </p>
          )}

          <div className="mt-3 flex flex-col gap-2 border-t border-border/60 pt-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {ticket.mailboxName && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background/35 px-2 py-1 text-[10px] text-muted-foreground">
                  <span className="size-1.5 rounded-full" style={{ backgroundColor: ticket.mailboxColor ?? undefined }} />
                  {ticket.mailboxName}
                </span>
              )}
              {ticket.tags.slice(0, 3).map((tag) => (
                <span
                  key={tag.name}
                  className="rounded-full px-2 py-1 text-[10px]"
                  style={{ backgroundColor: `${tag.color}22`, color: tag.color }}
                >
                  {tag.name}
                </span>
              ))}
              {ticket.tags.length > 3 && (
                <span className="text-[10px] text-muted-foreground">+{ticket.tags.length - 3}</span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              {waitingOnUs && (
                <span className="inline-flex items-center gap-1 font-semibold text-amber-300">
                  <MessageCircleReply className="size-3.5" />
                  Customer replied
                </span>
              )}
              <span className="inline-flex items-center gap-1"><CircleUserRound className="size-3" />{ticket.assigneeName ?? "Unassigned"}</span>
              <span className="inline-flex items-center gap-1"><Clock3 className="size-3" />{formatDateTime(ticket.lastMessageAt ?? ticket.updatedAt)}</span>
              <ArrowRight className="hidden size-3.5 text-primary opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100 sm:block" />
            </div>
          </div>
        </div>
      </div>
    </Link>
    </RecordContextMenu>
  );
}

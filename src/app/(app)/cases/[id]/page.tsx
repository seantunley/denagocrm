import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft, Paperclip, StickyNote, CircleDot, User as UserIcon, Car, X, Tag as TagIcon,
} from "lucide-react";
import { basePrisma } from "@/lib/db";
import { requireCaseReadAccess } from "@/lib/permissions";
import {
  getTicketDetail, listMailboxes, listCannedReplies, markCustomerMessagesRead,
} from "@/lib/helpdesk";
import { STATUSES, PRIORITIES, statusMeta } from "@/lib/helpdesk-constants";
import {
  replyToTicket, addNote, assignTicket, setTicketStatus, setTicketPriority,
  setTicketMailbox, addTicketTag, removeTicketTag,
} from "@/app/actions/helpdesk";
import { contactName, formatDateTime, formatDate } from "@/lib/format";
import { StatusPill } from "@/components/visual-system";
import { AutoSubmitSelect } from "@/components/helpdesk/AutoSubmitSelect";
import { TicketComposer } from "@/components/helpdesk/TicketComposer";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

type Upload = { id: string; fileName: string; sizeBytes: number; createdAt: Date };

export default async function TicketDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireCaseReadAccess(id);
  const ticket = await getTicketDetail(id);
  if (!ticket) notFound();
  await markCustomerMessagesRead(id);

  const [contact, vehicle, assignees, mailboxes, canned, uploads, otherTickets] = await Promise.all([
    basePrisma.contact.findUnique({ where: { id: ticket.contactId }, select: { id: true, firstName: true, lastName: true, company: true, isCompany: true, email: true, phone: true } }),
    ticket.vehicleId ? basePrisma.vehicle.findUnique({ where: { id: ticket.vehicleId }, select: { id: true, model: true, regNumber: true } }) : Promise.resolve(null),
    basePrisma.user.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    listMailboxes(),
    listCannedReplies(ticket.mailboxId),
    basePrisma.$queryRaw<Upload[]>`SELECT "id","fileName","sizeBytes","createdAt" FROM "PortalUpload" WHERE "caseId" = ${id} ORDER BY "createdAt" DESC`,
    basePrisma.customerCase.findMany({ where: { contactId: ticket.contactId, id: { not: id } }, orderBy: { updatedAt: "desc" }, take: 6, select: { id: true, number: true, subject: true, status: true } }),
  ]);

  const sm = statusMeta(ticket.status);
  const replyStatusOptions = [
    { value: "waiting_customer", label: "Pending customer" },
    { value: "open", label: "Open" },
    { value: "resolved", label: "Resolved" },
    { value: "closed", label: "Closed" },
  ];

  return (
    <div className="space-y-4">
      <Link href="/cases" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Help desk
      </Link>

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="truncate text-xl font-semibold tracking-tight">{ticket.subject}</h1>
          <StatusPill tone={sm.tone}>{sm.label}</StatusPill>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          C-{ticket.number.toString()} · {contact ? contactName(contact) : "Unknown"} · opened {formatDate(ticket.createdAt)}
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        {/* Conversation */}
        <div className="min-w-0 space-y-4">
          {ticket.thread.length === 0 && (
            <article className="card">
              <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                <UserIcon className="size-3.5" /> {contact ? contactName(contact) : "Customer"} · {formatDateTime(ticket.createdAt)}
              </div>
              <p className="whitespace-pre-wrap text-sm">{ticket.description}</p>
            </article>
          )}

          {ticket.thread.map((m) => {
            if (m.type === "event") {
              return (
                <div key={m.id} className="flex items-center justify-center gap-2 text-center text-xs text-muted-foreground">
                  <CircleDot className="size-3 shrink-0" /> <span>{m.body} · {m.authorName ?? "System"} · {formatDateTime(m.createdAt)}</span>
                </div>
              );
            }
            if (m.type === "note") {
              return (
                <article key={m.id} className="rounded-xl border border-amber-400/20 bg-amber-400/[0.05] p-4">
                  <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-amber-300">
                    <StickyNote className="size-3.5" /> Internal note · {m.authorName ?? "Staff"} · {formatDateTime(m.createdAt)}
                  </div>
                  <p className="whitespace-pre-wrap text-sm">{m.body}</p>
                </article>
              );
            }
            const staff = m.type === "staff";
            return (
              <article key={m.id} className={cn("card max-w-[92%]", staff ? "ml-auto border-primary/20 bg-primary/[0.04]" : "")}>
                <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                  <UserIcon className="size-3.5" /> {m.authorName ?? (staff ? "Staff" : "Customer")} · {formatDateTime(m.createdAt)}
                </div>
                <p className="whitespace-pre-wrap text-sm">{m.body}</p>
              </article>
            );
          })}

          <TicketComposer
            replyAction={replyToTicket.bind(null, ticket.id)}
            noteAction={addNote.bind(null, ticket.id)}
            cannedReplies={canned.map((c) => ({ id: c.id, title: c.title, body: c.body }))}
            statusOptions={replyStatusOptions}
          />
        </div>

        {/* Properties sidebar */}
        <aside className="space-y-4">
          <div className="card space-y-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Properties</p>
            <label className="block text-xs text-muted-foreground">Status
              <form action={setTicketStatus.bind(null, ticket.id)}>
                <AutoSubmitSelect name="status" defaultValue={ticket.status} aria-label="Status" options={STATUSES.map((s) => ({ value: s.value, label: s.label }))} />
              </form>
            </label>
            <label className="block text-xs text-muted-foreground">Assignee
              <form action={assignTicket.bind(null, ticket.id)}>
                <AutoSubmitSelect name="assigneeId" defaultValue={ticket.assigneeId ?? ""} aria-label="Assignee" options={[{ value: "", label: "Unassigned" }, ...assignees.map((u) => ({ value: u.id, label: u.name }))]} />
              </form>
            </label>
            <label className="block text-xs text-muted-foreground">Priority
              <form action={setTicketPriority.bind(null, ticket.id)}>
                <AutoSubmitSelect name="priority" defaultValue={ticket.priority} aria-label="Priority" options={PRIORITIES.map((p) => ({ value: p.value, label: p.label }))} />
              </form>
            </label>
            <label className="block text-xs text-muted-foreground">Mailbox
              <form action={setTicketMailbox.bind(null, ticket.id)}>
                <AutoSubmitSelect name="mailboxId" defaultValue={ticket.mailboxId ?? ""} aria-label="Mailbox" options={[{ value: "", label: "No mailbox" }, ...mailboxes.map((m) => ({ value: m.id, label: m.name }))]} />
              </form>
            </label>
          </div>

          <div className="card space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Tags</p>
            <div className="flex flex-wrap gap-1.5">
              {ticket.tags.map((t) => (
                <span key={t.id} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs" style={{ backgroundColor: `${t.color}22`, color: t.color }}>
                  {t.name}
                  <form action={removeTicketTag.bind(null, ticket.id, t.id)}>
                    <button type="submit" aria-label={`Remove ${t.name}`} className="opacity-60 hover:opacity-100"><X className="size-3" /></button>
                  </form>
                </span>
              ))}
              {ticket.tags.length === 0 && <span className="text-xs text-muted-foreground">No tags</span>}
            </div>
            <form action={addTicketTag.bind(null, ticket.id)} className="flex gap-1.5">
              <input name="name" placeholder="Add tag…" className="input h-8 py-0 text-xs" />
              <button className="btn-secondary h-8 px-2 text-xs"><TagIcon className="size-3.5" /></button>
            </form>
          </div>

          <div className="card space-y-2 text-sm">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Customer</p>
            {contact ? (
              <>
                <Link href={`/contacts/${contact.id}`} className="font-medium text-primary hover:underline">{contactName(contact)}</Link>
                {contact.email && <p className="truncate text-xs text-muted-foreground">{contact.email}</p>}
                {contact.phone && <p className="text-xs text-muted-foreground">{contact.phone}</p>}
              </>
            ) : <p className="text-muted-foreground">Unknown</p>}
            {vehicle && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Car className="size-3.5" />{vehicle.model}{vehicle.regNumber ? ` · ${vehicle.regNumber}` : ""}</p>
            )}
          </div>

          {uploads.length > 0 && (
            <div className="card space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Attachments</p>
              {uploads.map((u) => (
                <a key={u.id} href={`/api/cases/uploads/${u.id}`} className="flex items-center gap-2 text-xs text-primary hover:underline">
                  <Paperclip className="size-3.5 shrink-0" /> <span className="truncate">{u.fileName}</span>
                  <span className="shrink-0 text-muted-foreground">{Math.max(1, Math.round(u.sizeBytes / 1024))} KB</span>
                </a>
              ))}
            </div>
          )}

          {otherTickets.length > 0 && (
            <div className="card space-y-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Other tickets</p>
              {otherTickets.map((o) => (
                <Link key={o.id} href={`/cases/${o.id}`} className="flex items-center justify-between gap-2 text-xs hover:text-primary">
                  <span className="truncate">C-{o.number.toString()} · {o.subject}</span>
                  <StatusPill tone={statusMeta(o.status).tone}>{statusMeta(o.status).label}</StatusPill>
                </Link>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

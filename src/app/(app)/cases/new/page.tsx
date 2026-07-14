import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { prisma } from "@/lib/db";
import { requirePermission, getAccessibleContactIds } from "@/lib/permissions";
import { listMailboxes } from "@/lib/helpdesk";
import { TICKET_TYPES, PRIORITIES } from "@/lib/helpdesk-constants";
import { createTicket } from "@/app/actions/helpdesk";
import { contactName } from "@/lib/format";
import { PageHeader } from "@/components/page-header";

export const dynamic = "force-dynamic";

export default async function NewTicketPage() {
  const user = await requirePermission("cases.create");
  const contactIds = await getAccessibleContactIds(user);
  const [contacts, mailboxes] = await Promise.all([
    prisma.contact.findMany({
      where: contactIds === null ? {} : { id: { in: contactIds } },
      orderBy: { firstName: "asc" },
      take: 500,
      select: { id: true, firstName: true, lastName: true, company: true, isCompany: true },
    }),
    listMailboxes(),
  ]);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link href="/cases" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Help desk
      </Link>
      <PageHeader title="New ticket" description="Open a support ticket on behalf of a customer." />

      <form action={createTicket} className="card space-y-4">
        <div>
          <label className="label" htmlFor="contactId">Customer *</label>
          <select id="contactId" name="contactId" required defaultValue="" className="input">
            <option value="" disabled>Select a customer…</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>{contactName(c)}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="label" htmlFor="subject">Subject *</label>
          <input id="subject" name="subject" required className="input" placeholder="Short summary of the issue" />
        </div>

        <div>
          <label className="label" htmlFor="description">Description *</label>
          <textarea id="description" name="description" required rows={5} className="input min-h-28 resize-y" placeholder="What does the customer need help with?" />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor="type">Type</label>
            <select id="type" name="type" defaultValue="support" className="input capitalize">
              {TICKET_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="priority">Priority</label>
            <select id="priority" name="priority" defaultValue="normal" className="input">
              {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="mailboxId">Mailbox</label>
            <select id="mailboxId" name="mailboxId" defaultValue={mailboxes[0]?.id ?? ""} className="input">
              <option value="">No mailbox</option>
              {mailboxes.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="assignToMe" defaultChecked /> Assign to me
        </label>

        <div className="flex justify-end gap-2">
          <Link href="/cases" className="btn-secondary">Cancel</Link>
          <button className="btn-primary">Create ticket</button>
        </div>
      </form>
    </div>
  );
}

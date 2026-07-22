import { notFound } from "next/navigation";
import { Plus, Pencil, MessageSquareText, Tag, Inbox } from "lucide-react";
import { requirePermission } from "@/lib/permissions";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { listMailboxes, listTags, listCannedReplies } from "@/lib/helpdesk";
import {
  saveMailbox,
  saveCannedReply,
  deleteCannedReply,
  deleteTag,
} from "@/app/actions/helpdesk";
import ModalTrigger from "@/components/Modal";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { StatusPill, EmptyState } from "@/components/visual-system";

export const dynamic = "force-dynamic";

type Mailbox = Awaited<ReturnType<typeof listMailboxes>>[number];

function MailboxForm({ mailbox }: { mailbox?: Mailbox }) {
  return (
    <form action={saveMailbox} className="card space-y-4">
      {mailbox && <input type="hidden" name="id" value={mailbox.id} />}
      <div>
        <label className="label" htmlFor="mailbox-name">Name</label>
        <input id="mailbox-name" name="name" className="input" required minLength={2} defaultValue={mailbox?.name} placeholder="Support" />
      </div>
      <div>
        <label className="label" htmlFor="mailbox-email">Inbox address</label>
        <input id="mailbox-email" name="email" type="email" className="input" defaultValue={mailbox?.email ?? ""} placeholder="support@denagocpt.co.za" />
        <p className="text-xs text-muted-foreground mt-1">Email sent to this address becomes a ticket in this mailbox. Point this alias at your connected inbox (Settings → Email → IMAP).</p>
      </div>
      <div>
        <label className="label" htmlFor="mailbox-color">Colour</label>
        <input id="mailbox-color" type="color" name="color" className="input h-10 w-full p-1" defaultValue={mailbox?.color ?? "#ea580c"} />
      </div>
      <div>
        <label className="label" htmlFor="mailbox-signature">Signature</label>
        <textarea id="mailbox-signature" name="signature" className="input" rows={4} defaultValue={mailbox?.signature ?? ""} placeholder="Kind regards, the Denago team" />
      </div>
      <div className="space-y-2 border-t border-border pt-3">
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" name="autoReplyEnabled" value="on" className="h-4 w-4" defaultChecked={mailbox?.autoReplyEnabled ?? false} />
          Send an auto-reply when a new ticket arrives by email
        </label>
        <textarea name="autoReplyBody" className="input" rows={3} defaultValue={mailbox?.autoReplyBody ?? ""} placeholder="Thanks for contacting Denago — we've logged your request and will get back to you shortly." />
        <p className="text-xs text-muted-foreground">Sent once per new email ticket (never to automated / no-reply senders). The signature above is appended.</p>
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-300">
        <input type="checkbox" name="active" value="on" className="h-4 w-4" defaultChecked={mailbox ? mailbox.active : true} />
        Active
        <input type="hidden" name="active" value="off" />
      </label>
      <button className="btn-primary w-full">{mailbox ? "Save mailbox" : "Create mailbox"}</button>
    </form>
  );
}

function CannedReplyForm({ reply, mailboxes }: { reply?: Awaited<ReturnType<typeof listCannedReplies>>[number]; mailboxes: Mailbox[] }) {
  return (
    <form action={saveCannedReply} className="card space-y-4">
      {reply && <input type="hidden" name="id" value={reply.id} />}
      <div>
        <label className="label" htmlFor="reply-title">Title</label>
        <input id="reply-title" name="title" className="input" required minLength={2} defaultValue={reply?.title} placeholder="Order received" />
      </div>
      <div>
        <label className="label" htmlFor="reply-mailbox">Mailbox</label>
        <select id="reply-mailbox" name="mailboxId" className="input" defaultValue={reply?.mailboxId ?? ""}>
          <option value="">All mailboxes</option>
          {mailboxes.map((mailbox) => <option key={mailbox.id} value={mailbox.id}>{mailbox.name}</option>)}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="reply-body">Body</label>
        <textarea id="reply-body" name="body" className="input" rows={6} required minLength={2} defaultValue={reply?.body} placeholder="Thanks for reaching out — we've received your message…" />
      </div>
      <button className="btn-primary w-full">{reply ? "Save reply" : "Create reply"}</button>
    </form>
  );
}

export default async function HelpdeskSettingsPage() {
  if (!(await isModuleEnabled("support"))) notFound();
  await requirePermission("cases.manage");
  const [mailboxes, tags, cannedReplies] = await Promise.all([
    listMailboxes(false),
    listTags(),
    listCannedReplies(),
  ]);
  const mailboxName = (id: string | null) => (id ? mailboxes.find((mailbox) => mailbox.id === id)?.name ?? "Unknown mailbox" : "All mailboxes");

  return (
    <div className="space-y-10">
      <PageHeader
        title="Help desk"
        description="Configure the shared mailboxes, saved replies and tags used across customer support tickets."
      />

      {/* Mailboxes ─────────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="font-semibold tracking-tight">Mailboxes</h2>
            <p className="text-sm text-slate-400 mt-0.5">Route tickets into separate queues, each with its own colour and signature.</p>
          </div>
          <ModalTrigger label={<><Plus className="size-4" />New mailbox</>} title="New mailbox" buttonClass={buttonVariants({ size: "sm" })}>
            <MailboxForm />
          </ModalTrigger>
        </div>
        {mailboxes.length === 0 ? (
          <EmptyState icon={Inbox} title="No mailboxes yet" description="Create your first mailbox to start routing support tickets." />
        ) : (
          <div className="card p-0 divide-y divide-slate-800">
            {mailboxes.map((mailbox) => (
              <div key={mailbox.id} className="flex items-center justify-between gap-3 p-4">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="inline-block size-3 shrink-0 rounded-full" style={{ backgroundColor: mailbox.color }} />
                  <div className="min-w-0">
                    <p className="font-medium truncate">{mailbox.name}</p>
                    <p className="text-xs text-slate-500 truncate">{mailbox.slug}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <StatusPill tone={mailbox.active ? "success" : "neutral"}>{mailbox.active ? "Active" : "Inactive"}</StatusPill>
                  <ModalTrigger label={<><Pencil className="size-4" />Edit</>} title={`Edit ${mailbox.name}`} buttonClass={buttonVariants({ size: "sm", variant: "outline" })}>
                    <MailboxForm mailbox={mailbox} />
                  </ModalTrigger>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Saved replies ─────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="font-semibold tracking-tight">Saved replies</h2>
            <p className="text-sm text-slate-400 mt-0.5">Reusable canned responses agents can drop into a ticket.</p>
          </div>
          <ModalTrigger label={<><Plus className="size-4" />New reply</>} title="New saved reply" buttonClass={buttonVariants({ size: "sm" })}>
            <CannedReplyForm mailboxes={mailboxes} />
          </ModalTrigger>
        </div>
        {cannedReplies.length === 0 ? (
          <EmptyState icon={MessageSquareText} title="No saved replies yet" description="Create canned responses to answer common questions faster." />
        ) : (
          <div className="card p-0 divide-y divide-slate-800">
            {cannedReplies.map((reply) => (
              <div key={reply.id} className="flex items-start justify-between gap-3 p-4">
                <div className="min-w-0">
                  <p className="font-medium truncate">{reply.title}</p>
                  <p className="text-xs text-slate-500">{mailboxName(reply.mailboxId)}</p>
                  <p className="text-sm text-slate-400 mt-1 line-clamp-2">{reply.body}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <ModalTrigger label={<><Pencil className="size-4" />Edit</>} title={`Edit ${reply.title}`} buttonClass={buttonVariants({ size: "sm", variant: "outline" })}>
                    <CannedReplyForm reply={reply} mailboxes={mailboxes} />
                  </ModalTrigger>
                  <form action={deleteCannedReply.bind(null, reply.id)}>
                    <button className="text-red-400 text-sm">Delete</button>
                  </form>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Tags ──────────────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div>
          <h2 className="font-semibold tracking-tight">Tags</h2>
          <p className="text-sm text-slate-400 mt-0.5">Tags are created on the fly from a ticket. Remove any you no longer need here.</p>
        </div>
        {tags.length === 0 ? (
          <EmptyState icon={Tag} title="No tags yet" description="Tags appear here once agents start tagging tickets." />
        ) : (
          <div className="flex flex-wrap gap-2">
            {tags.map((tag) => (
              <form key={tag.id} action={deleteTag.bind(null, tag.id)}>
                <button className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/60 px-3 py-1 text-sm text-slate-300 transition-colors hover:border-red-400/40 hover:text-red-300" title={`Remove ${tag.name}`}>
                  <span className="inline-block size-2 rounded-full" style={{ backgroundColor: tag.color }} />
                  {tag.name}
                  <span aria-hidden className="text-slate-500">×</span>
                </button>
              </form>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

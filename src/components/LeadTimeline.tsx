import { Check, Pin, PinOff, Mail, MessageSquare, Phone, StickyNote, CalendarDays, History } from "lucide-react";
import CustomerHistory from "@/components/CustomerHistory";
import { auditEntryType, customerHistoryDay } from "@/lib/customerHistoryFilters";
import ConfirmDelete from "@/components/ConfirmDelete";
import { storedFileSrc } from "@/lib/storedFileSrc";
import { completeActivity } from "@/app/actions/activities";
import DealField from "@/components/DealField";
import type { DealOption } from "@/lib/customerTimeline";
import {
  addCommunication,
  deleteCommunication,
  toggleCommunicationPin,
} from "@/app/actions/communications";
import {
  toggleActivityPin,
  toggleContactNotePin,
  toggleLeadNotePin,
} from "@/app/actions/timelinePins";
import { formatDateTime } from "@/lib/format";
import { SEEN_HINT, seenLabel } from "@/lib/emailOpenTracking";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { isFutureDay } from "@/lib/activityDay";
import {
  getTimelinePins,
  type TimelinePinKind,
} from "@/lib/timelinePins";
import { compareTimelineItems } from "@/lib/timelineOrdering";
import { type FieldChange } from "@/lib/auditDetail";
import { FOLLOW_UP_TYPE } from "@/lib/followUp";
import { distinctLeadNotes } from "@/lib/timelineNotes";
import PasteImageInput from "@/components/PasteImageInput";
import EmailReplyButtons from "@/components/EmailReplyButtons";
import type { TimelineEmail } from "@/lib/emailReply";

/* eslint-disable @next/next/no-img-element */
const logo = (src: string, alt: string) => (
  <img
    src={src}
    alt={alt}
    className="h-3.5 w-3.5 rounded-[3px] object-contain"
  />
);
/* eslint-enable @next/next/no-img-element */

const icons: Record<string, React.ReactNode> = {
  note: "📝",
  call: "📞",
  email: "✉️",
  whatsapp: logo("/branding/social-whatsapp.png", "WhatsApp"),
  messenger: logo("/branding/social-facebook.png", "Messenger"),
  instagram: logo("/branding/social-instagram.png", "Instagram"),
  meeting: "🤝",
  audit: "•",
  lead: "◎",
  contact: "👤",
  automation: "🤖",
  activity: "✓",
  todo: "✓",
  test_drive: "🚗",
  follow_up: "🔁",
  document: "📄",
  creation: "🟢",
};

type PinTarget = {
  kind: TimelinePinKind;
  itemId: string;
};

type Item = {
  id: string;
  type?: string;
  communicationId?: string;
  ownerLabel?: string | null;
  attachmentType?: string | null;
  deliveredAt?: Date | null;
  icon: React.ReactNode;
  title: string;
  body?: string | null;
  image?: string | null;
  who: string;
  when: Date;
  /** "👁 Opened …" on an outbound message the customer opened (lib/emailOpenTracking.ts). */
  seen?: string | null;
  pending?: boolean;
  activityId?: string;
  activityStatus?: string;
  pinnedAt?: Date | null;
  pinTarget?: PinTarget;
  /** Field-level changes behind an audit entry, when the event recorded any. */
  changed?: FieldChange[];
  /** An email, for Reply / Reply all / Forward in the composer beside the timeline (workspace view). */
  email?: TimelineEmail;
};

/** `firstName` → "First name". Field names are for developers, not for a timeline. */
function fieldLabel(field: string): string {
  const spaced = field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/** A stored audit value as something a person can read. */
function auditValue(value: unknown): string {
  // "empty" has to be visible, or a cleared field reads as though nothing was
  // there before — which is the opposite of what the entry records.
  if (value === null || value === undefined || value === "") return "empty";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string") {
    // An ISO timestamp is stored as a string; showing the raw form is unkind.
    const asDate = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/.test(value) ? new Date(value) : null;
    if (asDate && !Number.isNaN(asDate.getTime())) return formatDateTime(asDate);
    return value.length > 120 ? `${value.slice(0, 117)}…` : value;
  }
  if (typeof value === "number") return String(value);
  const json = JSON.stringify(value);
  return json.length > 120 ? `${json.slice(0, 117)}…` : json;
}

function activityStatusLabel(status: string) {
  if (status === "done") return "Completed";
  if (status === "canceled" || status === "cancelled") return "Cancelled";
  return status.replaceAll("_", " ");
}

export default async function LeadTimeline({
  leadId,
  contactId,
  revalidate,
  audit,
  auditDetail,
  communications,
  activities = [],
  creationNote,
  leadNotes = [],
  notesFromLeadId = null,
  deals = [],
  workspace,
}: {
  workspace?: { composer: React.ReactNode; context: React.ReactNode };
  /** The customer's open deals, on a customer's page (lib/customerTimeline.dealChoice). */
  deals?: readonly DealOption[];
  leadId?: string;
  contactId?: string;
  revalidate: string;
  audit: {
    id: string;
    action: string;
    summary: string;
    userName: string;
    createdAt: Date;
  }[];
  /** Detail per audit row id. Absent for entries with no matching event. */
  auditDetail?: Record<string, { changed: FieldChange[] }>;
  communications: {
    id: string;
    type: string;
    direction: string | null;
    subject: string | null;
    body: string;
    attachmentUrl?: string | null;
    attachmentType?: string | null;
    deliveredAt?: Date | null;
    /** Who a sent email was copied to (Communication.cc) — Reply all's addresses. */
    cc?: string | null;
    ownerLabel?: string | null;
    occurredAt: Date;
    seenAt?: Date | null;
    openCount?: number;
    bannerClickedAt?: Date | null;
    user: { name: string };
  }[];
  activities?: {
    id: string;
    type: string;
    summary: string;
    note?: string | null;
    location?: string | null;
    dueDate: Date;
    status: string;
    assignedTo?: { name: string } | null;
  }[];
  creationNote: { text: string; when: Date; who: string } | null;
  /**
   * Notes belonging to leads linked to THIS contact. Supplied by the contact
   * page so a `lead_note` pin stays visible (and unpinnable) from the customer
   * view — otherwise the pin row exists but has no item to render on.
   */
  /**
   * The lead whose notes were copied into this contact's own note, if any. Used
   * to drop exactly that lead's duplicate entry — see lib/timelineNotes.ts for
   * why this is a recorded id and not a text comparison.
   */
  notesFromLeadId?: string | null;
  leadNotes?: {
    leadId: string;
    title: string;
    text: string;
    when: Date;
    who: string;
  }[];
}) {
  const originalNoteTarget: PinTarget | null = creationNote
    ? contactId
      ? { kind: "contact_note", itemId: contactId }
      : leadId
        ? { kind: "lead_note", itemId: leadId }
        : null
    : null;

  // See lib/timelineNotes.ts: a lead note that IS the contact's note is one note.
  const shownLeadNotes = distinctLeadNotes(leadNotes, notesFromLeadId);

  const targets: Array<{ kind: TimelinePinKind; itemId: string }> = [
    ...activities.map((activity) => ({
      kind: "activity" as const,
      itemId: activity.id,
    })),
    ...communications.map((communication) => ({
      kind: "communication" as const,
      itemId: communication.id,
    })),
    ...shownLeadNotes.map((note) => ({
      kind: "lead_note" as const,
      itemId: note.leadId,
    })),
    ...(originalNoteTarget ? [originalNoteTarget] : []),
  ];
  const pins = await getTimelinePins(targets);
  const pinByTarget = new Map(
    pins.map((pin) => [`${pin.kind}:${pin.itemId}`, pin.pinnedAt]),
  );
  const pinnedAt = (kind: TimelinePinKind, itemId: string) =>
    pinByTarget.get(`${kind}:${itemId}`) ?? null;

  const items: Item[] = [
    ...activities.map((activity): Item => ({
      id: `act-${activity.id}`,
      type: "activity",
      icon: icons[activity.type] ?? icons.activity,
      title: activity.summary,
      body:
        activity.type === FOLLOW_UP_TYPE && activity.note
          ? activity.note
          : activity.location
            ? `📍 ${activity.location}`
            : null,
      who: activity.assignedTo?.name ?? "Unassigned",
      when: activity.dueDate,
      pending: activity.status === "planned",
      activityId: activity.id,
      activityStatus: activity.status,
      pinnedAt: pinnedAt("activity", activity.id),
      pinTarget: { kind: "activity", itemId: activity.id },
    })),
    ...audit.map((entry): Item => ({
      id: `a-${entry.id}`,
      type: auditEntryType(entry.action),
      icon: icons[entry.action.split(".")[0]] ?? "•",
      title: entry.summary,
      who: entry.userName,
      when: entry.createdAt,
      changed: auditDetail?.[entry.id]?.changed,
    })),
    ...communications.map((communication): Item => ({
      id: `c-${communication.id}`,
      type: communication.type,
      communicationId: communication.id,
      ownerLabel: communication.ownerLabel,
      attachmentType: communication.attachmentType,
      deliveredAt: communication.direction === "outbound" ? communication.deliveredAt : null,
      icon: icons[communication.type] ?? "💬",
      title: `${communication.type.charAt(0).toUpperCase() + communication.type.slice(1)}${
        communication.direction ? ` (${communication.direction})` : ""
      }${communication.subject ? `: ${communication.subject}` : ""}`,
      body: communication.body,
      // Through the app, not the raw storage link: private files have none.
      image: storedFileSrc(communication.attachmentUrl),
      who: communication.user.name,
      when: communication.occurredAt,
      seen: seenLabel(communication),
      email: communication.type === "email"
        ? { id: communication.id, subject: communication.subject, body: communication.body, occurredAt: communication.occurredAt.toISOString(), direction: communication.direction, staffName: communication.user.name, cc: communication.cc ?? null }
        : undefined,
      pinnedAt: pinnedAt("communication", communication.id),
      pinTarget: { kind: "communication", itemId: communication.id },
    })),
    ...(creationNote
      ? [
          {
            id: "creation-note",
            type: "note",
            icon: icons.creation,
            title: contactId ? "Original contact note" : "Original lead note",
            body: creationNote.text,
            who: creationNote.who,
            when: creationNote.when,
            pinnedAt: originalNoteTarget
              ? pinnedAt(originalNoteTarget.kind, originalNoteTarget.itemId)
              : null,
            pinTarget: originalNoteTarget ?? undefined,
          } satisfies Item,
        ]
      : []),
    ...shownLeadNotes.map((note): Item => ({
      id: `lead-note-${note.leadId}`,
      type: "note",
      icon: icons.lead,
      title: `Original lead note — ${note.title}`,
      body: note.text,
      who: note.who,
      when: note.when,
      pinnedAt: pinnedAt("lead_note", note.leadId),
      pinTarget: { kind: "lead_note", itemId: note.leadId },
    })),
  ].sort(compareTimelineItems);

  const pinnedItems = items.filter((item) => Boolean(item.pinnedAt));
  const historyItems = items.filter((item) => !item.pinnedAt);

  const renderItem = (item: Item, inPinnedShelf = false) => {
    const isPinned = Boolean(item.pinnedAt);
    const pinAction =
      item.pinTarget?.kind === "activity"
        ? toggleActivityPin.bind(null, item.pinTarget.itemId, revalidate)
        : item.pinTarget?.kind === "communication"
          ? toggleCommunicationPin.bind(null, item.pinTarget.itemId, revalidate)
          : item.pinTarget?.kind === "contact_note"
            ? toggleContactNotePin.bind(null, item.pinTarget.itemId, revalidate)
            : item.pinTarget?.kind === "lead_note"
              ? toggleLeadNotePin.bind(null, item.pinTarget.itemId, revalidate)
              : null;

    const canComplete = Boolean(item.pending && item.activityId);

    const pinButton =
      item.pinTarget && pinAction ? (
        <SaveForm action={pinAction} className="shrink-0">
          <SaveButton
            pendingLabel={isPinned ? "Unpinning…" : "Pinning…"}
            title={isPinned ? "Unpin from the top" : "Pin to the top"}
            aria-label={
              isPinned ? "Unpin timeline entry" : "Pin timeline entry"
            }
            className={workspace ? "inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary" : `inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/70 ${
              isPinned
                ? "border-orange-400/50 bg-orange-500/20 text-orange-100 shadow-sm shadow-orange-950/30 hover:bg-orange-500/30"
                : "border-slate-600 bg-slate-800 text-slate-200 hover:border-orange-400/50 hover:bg-orange-500/10 hover:text-orange-100"
            }`}
          >
            {isPinned ? (
              <PinOff className="size-4" />
            ) : (
              <Pin className="size-4" />
            )}
            {isPinned ? "Unpin" : "Pin"}
          </SaveButton>
        </SaveForm>
      ) : null;

    if (workspace) {
      const Icon = item.type === "email" ? Mail : item.type === "call" ? Phone : item.type === "note" ? StickyNote : item.type === "activity" ? CalendarDays : item.type?.startsWith("audit") ? History : MessageSquare;
      return (
        <li key={item.id} className={inPinnedShelf ? "min-w-0 border-l-2 border-amber-400/50 pl-3" : "group min-w-0 border-b border-border/60 py-4 last:border-0"}>
          <div className="flex items-start gap-3">
            {!inPinnedShelf && <span className="mt-0.5 rounded-lg bg-muted p-2 text-muted-foreground"><Icon className="size-4" aria-hidden="true" /></span>}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="break-words text-sm font-medium [overflow-wrap:anywhere]">{item.title}</p>
                {item.type === "note" && <span className="text-xs text-muted-foreground">Internal</span>}
                {item.pending && <span className="text-xs text-amber-400">{item.when < new Date() ? "Overdue" : "Upcoming"}</span>}
                {item.activityStatus && item.activityStatus !== "planned" && <span className="text-xs text-muted-foreground">{activityStatusLabel(item.activityStatus)}</span>}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{item.who} · {formatDateTime(item.when)}</p>
              {item.ownerLabel && <p className="mt-1 text-xs text-primary">{item.ownerLabel}</p>}
              {item.body && item.body !== "🖼 Image" && (item.body.length > (inPinnedShelf ? 140 : 350) ? (
                <details className="mt-2 text-sm text-muted-foreground">
                  <summary className="cursor-pointer whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{item.body.slice(0, inPinnedShelf ? 140 : 350)}… <span className="text-primary">Read more</span></summary>
                  <p className="mt-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{item.body}</p>
                </details>
              ) : <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">{item.body}</p>)}
              {item.image && <a href={item.image} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex max-w-full flex-col gap-1 text-xs text-primary">
                {(!item.attachmentType || item.attachmentType === "image") && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.image} alt="Attached image" loading="lazy" className={inPinnedShelf ? "max-h-20 max-w-full rounded-md border border-border object-contain" : "max-h-28 max-w-full rounded-md border border-border object-contain"} />
                )}
                Open attachment in new tab
              </a>}
              {item.seen ? <p className="mt-2 text-xs text-emerald-400" title={item.type === "email" ? SEEN_HINT : undefined}>{item.seen}</p> : item.deliveredAt ? <p className="mt-2 text-xs text-emerald-400">Delivered · {formatDateTime(item.deliveredAt)}</p> : null}
              {item.changed && item.changed.length > 0 && <details className="mt-2 text-xs"><summary className="cursor-pointer text-muted-foreground">{item.changed.length} field changes</summary><dl className="mt-2 space-y-2">{item.changed.map((change) => <div key={change.field}><dt className="font-medium">{fieldLabel(change.field)}</dt><dd className="break-words text-muted-foreground [overflow-wrap:anywhere]"><span className="line-through">{auditValue(change.before)}</span> → {auditValue(change.after)}</dd></div>)}</dl></details>}
              {!inPinnedShelf && item.email && <EmailReplyButtons email={item.email} />}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {pinButton}
                {!inPinnedShelf && item.communicationId && <ConfirmDelete action={deleteCommunication.bind(null, item.communicationId, revalidate)} title="Delete this timeline entry?" description="This cannot be undone. The deletion is recorded in the customer history." trigger="Delete entry" triggerClass="rounded-md px-2 py-2 text-xs text-muted-foreground hover:text-red-400 focus-visible:ring-2 focus-visible:ring-primary" />}
              </div>
              {!inPinnedShelf && item.pending && item.activityId && !isFutureDay(item.when) && <SaveForm action={completeActivity.bind(null, item.activityId)} className="mt-3 flex flex-wrap gap-2">
                <input type="hidden" name="revalidate" value={revalidate} />
                <input name="note" aria-label="Activity completion note" placeholder="Completion note (optional)" className="input min-w-0 flex-1 text-xs" />
                <SaveButton className="btn-secondary btn-sm" pendingLabel="Saving…"><Check className="mr-1 size-3" />Mark done</SaveButton>
              </SaveForm>}
            </div>
          </div>
        </li>
      );
    }

    return (
      <li
        key={item.id}
        className={`relative rounded-xl border px-3 py-3 transition-all ${
          inPinnedShelf
            ? "border-orange-400/30 bg-orange-500/[0.07]"
            : "ml-5 border-transparent hover:border-slate-700/80 hover:bg-slate-900/30"
        }`}
      >
        <span
          className={`${
            inPinnedShelf
              ? "mr-2 inline-flex align-middle"
              : "absolute -left-[31px] top-3 flex"
          } h-5 w-5 items-center justify-center rounded-full text-[10px] ${
            isPinned
              ? "bg-orange-500/25 ring-1 ring-orange-400/60"
              : item.pending
                ? "bg-amber-500/20 ring-1 ring-amber-500/40"
                : "bg-slate-800"
          }`}
        >
          {item.icon}
        </span>

        <div className="flex items-start gap-2.5">
          <div className="min-w-0 flex-1">
            <p className="break-words text-sm text-slate-200 [overflow-wrap:anywhere]">
              {isPinned && (
                <span className="mr-2 inline-flex items-center gap-1 rounded-full border border-orange-400/25 bg-orange-500/15 px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-orange-200">
                  <Pin className="size-2.5 fill-current" />
                  Pinned
                </span>
              )}
              {item.pending && (
                <span className="mr-2 rounded-full bg-amber-500/15 px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-amber-300">
                  {item.when < new Date() ? "Overdue" : "Upcoming"}
                </span>
              )}
              {item.activityStatus && item.activityStatus !== "planned" && (
                <span className="mr-2 rounded-full bg-slate-700/70 px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-slate-300">
                  {activityStatusLabel(item.activityStatus)}
                </span>
              )}
              {item.title}
            </p>

            {item.image && (
              <a href={item.image} target="_blank">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={item.image}
                  alt="Attachment"
                  className="mt-2 max-h-36 rounded-lg border border-slate-700 transition-colors hover:border-orange-500"
                />
              </a>
            )}
            {item.body && item.body !== "🖼 Image" && (
              <p className="mt-1 line-clamp-4 break-words whitespace-pre-wrap text-xs text-slate-400 [overflow-wrap:anywhere]">
                {item.body}
              </p>
            )}
            {item.changed && item.changed.length > 0 && (
              // Collapsed by default: the timeline's job is still the sequence of
              // events, and a wall of field changes on every row would bury it.
              // `<details>` keeps this working without client state.
              <details className="group/detail mt-1.5">
                <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs text-slate-400 transition-colors hover:text-slate-200">
                  <span className="transition-transform group-open/detail:rotate-90">›</span>
                  {item.changed.length === 1
                    ? "1 field changed"
                    : `${item.changed.length} fields changed`}
                </summary>
                <dl className="mt-1.5 space-y-1 border-l border-slate-700 pl-3">
                  {item.changed.map((change) => (
                    <div key={change.field} className="text-xs">
                      <dt className="font-medium text-slate-400">{fieldLabel(change.field)}</dt>
                      <dd className="flex flex-wrap items-baseline gap-1.5 text-slate-300 [overflow-wrap:anywhere]">
                        <span className="text-slate-500 line-through">{auditValue(change.before)}</span>
                        <span className="text-slate-600">→</span>
                        <span>{auditValue(change.after)}</span>
                      </dd>
                    </div>
                  ))}
                </dl>
              </details>
            )}
            <p className="mt-1 text-xs text-slate-500">
              <span className="font-medium text-slate-400">{item.who}</span>{" "}
              · {formatDateTime(item.when)}
              {item.seen && (
                <span className="badge ml-2 bg-emerald-500/15 text-emerald-300" title={SEEN_HINT}>
                  {item.seen}
                </span>
              )}
            </p>
          </div>

          {!canComplete && pinButton}
        </div>

        {/* `!isFutureDay` — the tick is not offered before the day arrives, matching
            the refusal in finishActivity. `when` IS the activity's dueDate here. */}
        {item.pending && item.activityId && !isFutureDay(item.when) && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {pinButton}
            <SaveForm
              action={completeActivity.bind(null, item.activityId)}
              className="flex min-w-0 flex-1 basis-full flex-wrap items-center gap-2 sm:basis-auto sm:flex-nowrap"
            >
              <input type="hidden" name="revalidate" value={revalidate} />
              <input
                type="text"
                name="note"
                placeholder="Add a note (optional)"
                className="input h-9 min-w-0 flex-1 basis-full text-xs sm:w-52 sm:basis-auto"
              />
              <SaveButton
                pendingLabel="Saving…"
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-emerald-500/50 bg-emerald-500/15 px-3 text-xs font-semibold text-emerald-100 transition-all hover:border-emerald-400/70 hover:bg-emerald-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70"
              >
                <Check className="size-4" />
                Mark done
              </SaveButton>
            </SaveForm>
          </div>
        )}
      </li>
    );
  };

  if (workspace) {
    // Pins are shortcuts in the sidebar; the complete, chronological history remains filterable.
    const chronological = [...items].sort((a, b) => b.when.getTime() - a.when.getTime());
    return <CustomerHistory
      subject={leadId ? "Deal" : "Customer"}
      composer={workspace.composer}
      context={workspace.context}
      pinned={pinnedItems.map((item) => renderItem(item, true))}
      entries={chronological.map((item) => ({ id: item.id, type: item.type ?? "audit", day: customerHistoryDay(item.when), content: renderItem(item) }))}
    />;
  }

  return (
    <div id="live-timeline" className="card min-w-0 scroll-mt-24">
      <div className="mb-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">Live timeline</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Use the visible Pin button on any note or activity. Pinned items stay in the shelf below until you unpin them.
            </p>
          </div>
          {pinnedItems.length > 0 && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-orange-400/30 bg-orange-500/10 px-2 py-1 text-[11px] font-semibold text-orange-200">
              <Pin className="size-3 fill-current" />
              {pinnedItems.length}
            </span>
          )}
        </div>
      </div>

      <SaveForm action={addCommunication} className="mb-5 space-y-2">
        {leadId && <input type="hidden" name="leadId" value={leadId} />}
        {contactId && (
          <input type="hidden" name="contactId" value={contactId} />
        )}
        {/* On a customer's page: which of their deals this note is about (asked only when there are several). */}
        {!leadId && deals.length > 0 && <DealField deals={deals} id="timeline-note-deal" />}
        <input type="hidden" name="type" value="note" />
        <input type="hidden" name="direction" value="" />
        <input type="hidden" name="revalidate" value={revalidate} />
        <textarea
          name="body"
          className="input"
          rows={2}
          placeholder="Add an internal note…"
        />
        <PasteImageInput />
        <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-300">
          <input
            type="checkbox"
            name="pin"
            className="size-3.5 rounded border-slate-700 bg-slate-900 accent-orange-500"
          />
          <Pin className="size-3.5 text-orange-300" />
          Pin this note immediately
        </label>
        <SaveButton className="btn-secondary btn-sm w-full" pendingLabel="Adding…">+ Add note</SaveButton>
      </SaveForm>

      {pinnedItems.length > 0 && (
        <section className="mb-5 overflow-hidden rounded-2xl border border-orange-400/30 bg-gradient-to-b from-orange-500/[0.10] to-orange-500/[0.03]">
          <div className="flex items-center justify-between border-b border-orange-400/20 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className="grid size-7 place-items-center rounded-full bg-orange-500/20 text-orange-200">
                <Pin className="size-4 fill-current" />
              </span>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-orange-200">
                  Pinned
                </p>
                <p className="text-[11px] text-orange-100/60">
                  Always visible above the scrolling history
                </p>
              </div>
            </div>
          </div>
          <ol className="max-h-72 space-y-2 overflow-y-auto p-2 [scrollbar-width:thin]">
            {pinnedItems.map((item) => renderItem(item, true))}
          </ol>
        </section>
      )}

      {historyItems.length === 0 ? (
        <p className="text-sm text-slate-500">
          {pinnedItems.length > 0
            ? "No other timeline entries."
            : "Nothing recorded yet."}
        </p>
      ) : (
        <div className="max-h-96 overflow-y-auto pr-1 [scrollbar-width:thin]">
          <ol className="relative ml-3 space-y-3 border-l border-slate-800 py-0.5">
            {historyItems.map((item) => renderItem(item))}
          </ol>
        </div>
      )}
    </div>
  );
}
